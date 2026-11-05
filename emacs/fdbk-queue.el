;;; fdbk-queue.el --- What is waiting for your review  -*- lexical-binding: t; -*-

;; Author: Jeremy Dormitzer <jeremy.dormitzer@gmail.com>
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1") (magit "4.0") (transient "0.6"))
;; Keywords: git tools vc

;;; Commentary:

;; `fdbk-queue' lists agent work and pull requests waiting for your
;; review in the repositories named by `fdbk-queue-repositories', grouped
;; by why they need you and ordered by `fdbk-queue-weights'.  From the
;; list you can start or resume a git-feedback review of an item, look
;; at its diff, open the pull request or jump to the agent's session.
;;
;; The data comes from `fdbk queue --json'.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'magit-section)
(require 'fdbk)

(declare-function opencode-open-session-by-id "emacs-opencode")

;;; Customization

(defcustom fdbk-queue-repositories nil
  "Local clones whose agent work and pull requests the queue lists."
  :type '(repeat directory)
  :group 'fdbk)

(defcustom fdbk-queue-days 7
  "Only agent sessions active within this many days count as agent work."
  :type 'natnum
  :group 'fdbk)

(defcustom fdbk-queue-weights
  '((agent-replied . 60)
    (requested-you . 50)
    (changed-since-review . 40)
    (new-agent-work . 40)
    (requested-team . 20)
    (teammate . 15)
    (familiar-file . 5)
    (approval . -10)
    (running . -30)
    (bot . -40)
    (day-old . 1))
  "Points each signal adds to an item's score.
Items are ordered by score within their group.  `familiar-file',
`approval' and `day-old' count once per file, approval or day, up to
`fdbk-queue-max-count'."
  :type '(alist :key-type symbol :value-type integer)
  :group 'fdbk)

(defcustom fdbk-queue-max-count 5
  "Most times a counted signal such as `familiar-file' adds to a score."
  :type 'natnum
  :group 'fdbk)

(defcustom fdbk-queue-dismissed-file (locate-user-emacs-file "fdbk-queue-dismissed.eld")
  "File remembering items you dismissed from the queue."
  :type 'file
  :group 'fdbk)

(defface fdbk-queue-reason
  '((t :inherit font-lock-comment-face))
  "Face for the reasons an item is in the queue."
  :group 'fdbk)

(defface fdbk-queue-detail
  '((t :inherit shadow))
  "Face for an item's author, branch, age and size."
  :group 'fdbk)

;;; State

(defvar fdbk-queue--data nil
  "The last output of `fdbk queue --json'.")

(defvar fdbk-queue--error nil
  "Error text from the last failed refresh, if any.")

(defvar fdbk-queue--refreshing nil
  "Non-nil while a refresh is running.")

(defvar fdbk-queue--dismissed nil
  "Alist of dismissed item ids and the item version they were dismissed at.")

(defconst fdbk-queue--buffer-name "*fdbk-queue*")

(defconst fdbk-queue--groups
  '((agent "Agent work")
    (re-review "Re-review")
    (requested "Requested from you")
    (team "Your team")
    (other "Everything else" t)
    (dismissed "Dismissed" t))
  "Groups in display order: (KEY TITLE HIDDEN).")

;;; Scoring

(defun fdbk-queue--age-days (item)
  "Return how many whole days ago ITEM was created or last updated."
  (let ((time (or (plist-get item :createdAt) (plist-get item :updatedAt))))
    (max 0 (floor (/ (float-time (time-subtract nil (date-to-time time))) 86400)))))

(defun fdbk-queue--signals (item)
  "Return ITEM's scoring signals as a list of (SIGNAL COUNT LABEL).
LABEL is nil for signals that are not worth showing."
  (let ((state (plist-get item :state))
        (count (lambda (n) (min n fdbk-queue-max-count)))
        (plural (lambda (n word) (format "%d %s%s" n word (if (= n 1) "" "s")))))
    (delq nil
          (list
           (pcase state
             ("agent-replied" '(agent-replied 1 "agent replied"))
             ("changed-since-review" '(changed-since-review 1 "changed since your review"))
             ((guard (equal (plist-get item :kind) "agent")) '(new-agent-work 1 "not reviewed yet")))
           (pcase (plist-get item :requested)
             ("you" '(requested-you 1 "requested from you"))
             ("team" '(requested-team 1 "requested from your team")))
           (when (plist-get item :authorOnTeam) '(teammate 1 "teammate"))
           (let ((n (or (plist-get item :familiarFiles) 0)))
             (when (> n 0)
               (list 'familiar-file (funcall count n)
                     (concat (funcall plural n "file") " you changed recently"))))
           (let ((n (or (plist-get item :approvals) 0)))
             (when (> n 0) (list 'approval (funcall count n) (funcall plural n "approval"))))
           (when (plist-get item :running) '(running 1 "agent still running"))
           (when (plist-get item :authorIsBot) '(bot 1 "bot"))
           (list 'day-old (funcall count (fdbk-queue--age-days item)) nil)))))

(defun fdbk-queue--score (item)
  "Return ITEM's priority score under `fdbk-queue-weights'."
  (cl-loop for (signal n) in (fdbk-queue--signals item)
           sum (* n (alist-get signal fdbk-queue-weights 0))))

(defun fdbk-queue--labels (item)
  "Return the labels explaining why ITEM is in the queue."
  (delq nil (mapcar #'caddr (fdbk-queue--signals item))))

;;; Dismissing

(defun fdbk-queue--load-dismissed ()
  "Read `fdbk-queue--dismissed' from `fdbk-queue-dismissed-file'."
  (setq fdbk-queue--dismissed
        (when (file-readable-p fdbk-queue-dismissed-file)
          (with-temp-buffer
            (insert-file-contents fdbk-queue-dismissed-file)
            (ignore-errors (read (current-buffer)))))))

(defun fdbk-queue--save-dismissed ()
  "Write `fdbk-queue--dismissed' to `fdbk-queue-dismissed-file'."
  (with-temp-file fdbk-queue-dismissed-file
    (let ((print-length nil) (print-level nil))
      (prin1 fdbk-queue--dismissed (current-buffer)))))

(defun fdbk-queue--dismissed-p (item)
  "Return non-nil if ITEM was dismissed and has not changed since."
  (equal (alist-get (plist-get item :id) fdbk-queue--dismissed nil nil #'equal)
         (plist-get item :version)))

;;; Rendering

(defun fdbk-queue--group (item)
  "Return the key of the group ITEM belongs in."
  (cond ((fdbk-queue--dismissed-p item) 'dismissed)
        ((equal (plist-get item :kind) "agent") 'agent)
        ((equal (plist-get item :state) "changed-since-review") 're-review)
        ((equal (plist-get item :requested) "you") 'requested)
        ((or (plist-get item :requested) (plist-get item :authorOnTeam)) 'team)
        (t 'other)))

(defun fdbk-queue--sort (items)
  "Sort ITEMS by score, then by most recently updated."
  (sort (copy-sequence items)
        (lambda (a b)
          (let ((sa (fdbk-queue--score a)) (sb (fdbk-queue--score b)))
            (if (= sa sb)
                (string> (plist-get a :updatedAt) (plist-get b :updatedAt))
              (> sa sb))))))

(defun fdbk-queue--age-label (item)
  "Return a short label for how long ago ITEM was updated."
  (let ((seconds (float-time (time-subtract nil (date-to-time (plist-get item :updatedAt))))))
    (cond ((< seconds 3600) (format "%dm" (/ seconds 60)))
          ((< seconds 86400) (format "%dh" (/ seconds 3600)))
          (t (format "%dd" (/ seconds 86400))))))

(defun fdbk-queue--detail (item)
  "Return where ITEM lives, its age and its size."
  (let ((size (plist-get item :size))
        (repo (car (last (split-string (plist-get item :repo) "/")))))
    (format "%-32s %4s %6s %6s"
            (truncate-string-to-width
             (if (equal (plist-get item :kind) "agent")
                 (format "%s %s" repo (file-name-nondirectory (directory-file-name (plist-get item :dir))))
               (format "%s#%d %s" repo (plist-get item :number) (plist-get item :author)))
             32)
            (fdbk-queue--age-label item)
            (format "+%d" (plist-get size :additions))
            (format "-%d" (plist-get size :deletions)))))

(defvar-keymap fdbk-queue-item-section-map
  :doc "Keymap for an item in the review queue."
  "RET" #'fdbk-queue-review
  "d" #'fdbk-queue-diff
  "o" #'fdbk-queue-browse
  "a" #'fdbk-queue-agent-session
  "m" #'fdbk-queue-magit-status
  "x" #'fdbk-queue-dismiss)

(defclass fdbk-queue-item-section (magit-section)
  ((keymap :initform 'fdbk-queue-item-section-map))
  "Magit section for an item in the review queue.")

(defclass fdbk-queue-group-section (magit-section) ()
  "Magit section for a group of items in the review queue.")

(defun fdbk-queue--insert-item (item)
  "Insert a line for ITEM."
  (magit-insert-section (fdbk-queue-item-section item)
    (insert (truncate-string-to-width (plist-get item :title) 60 nil ?\s "…")
            "  " (propertize (fdbk-queue--detail item) 'font-lock-face 'fdbk-queue-detail))
    (when-let* ((labels (fdbk-queue--labels item)))
      (insert "  " (propertize (string-join labels " · ") 'font-lock-face 'fdbk-queue-reason)))
    (insert "\n")))

(defun fdbk-queue--insert-header ()
  "Insert the status lines at the top of the queue."
  (let ((generated (plist-get fdbk-queue--data :generatedAt)))
    (insert (propertize "Review queue" 'font-lock-face 'magit-section-heading)
            (if generated (format-time-string "  updated %H:%M" (date-to-time generated)) "")
            (if fdbk-queue--refreshing "  refreshing…" "")
            "\n")
    (when fdbk-queue--error
      (insert (propertize (concat "Refresh failed: " fdbk-queue--error) 'font-lock-face 'error) "\n"))
    (dolist (warning (plist-get fdbk-queue--data :warnings))
      (insert (propertize warning 'font-lock-face 'warning) "\n"))
    (insert "\n")))

(defun fdbk-queue--item-at-point ()
  "Return the queue item at point, or signal a user error."
  (let ((section (magit-current-section)))
    (unless (cl-typep section 'fdbk-queue-item-section)
      (user-error "No queue item at point"))
    (oref section value)))

(defun fdbk-queue--render (&optional at)
  "Redraw the queue buffer from `fdbk-queue--data', keeping folding.
Leave point on the item with id AT, or the item at point before."
  (let ((inhibit-read-only t)
        (at (or at (ignore-errors (plist-get (fdbk-queue--item-at-point) :id))))
        (hidden (and magit-root-section
                     (mapcar (lambda (s) (cons (oref s value) (oref s hidden)))
                             (oref magit-root-section children))))
        (groups (seq-group-by #'fdbk-queue--group (plist-get fdbk-queue--data :items))))
    (erase-buffer)
    (magit-insert-section (fdbk-queue-root)
      (fdbk-queue--insert-header)
      (pcase-dolist (`(,key ,title ,hide) fdbk-queue--groups)
        (when-let* ((items (alist-get key groups)))
          (magit-insert-section (fdbk-queue-group-section key (alist-get key hidden hide))
            (magit-insert-heading (format "%s (%d)" title (length items)))
            (mapc #'fdbk-queue--insert-item (fdbk-queue--sort items))
            (insert "\n")))))
    (goto-char (point-min))
    (when at
      (when-let* ((section (seq-find (lambda (s) (and (equal (plist-get (oref s value) :id) at)
                                                      (not (oref (oref s parent) hidden))))
                                     (seq-mapcat (lambda (g) (oref g children))
                                                 (oref magit-root-section children)))))
        (goto-char (oref section start))))))

(defun fdbk-queue--render-buffer ()
  "Redraw the queue buffer, if it exists."
  (when-let* ((buffer (get-buffer fdbk-queue--buffer-name)))
    (with-current-buffer buffer (fdbk-queue--render))))

;;; Commands

(defun fdbk-queue--receive (data)
  "Show DATA from `fdbk queue --json' and forget dismissals of items now gone."
  (let ((ids (mapcar (lambda (item) (plist-get item :id)) (plist-get data :items))))
    (setq fdbk-queue--data data
          fdbk-queue--error nil
          fdbk-queue--refreshing nil
          fdbk-queue--dismissed (seq-filter (lambda (entry) (member (car entry) ids))
                                            fdbk-queue--dismissed))
    (fdbk-queue--save-dismissed)
    (fdbk-queue--render-buffer)))

(defun fdbk-queue--fail (error)
  "Show ERROR from a failed refresh."
  (setq fdbk-queue--error error fdbk-queue--refreshing nil)
  (fdbk-queue--render-buffer))

(defun fdbk-queue-refresh ()
  "Fetch the queue again in the background."
  (interactive)
  (unless fdbk-queue-repositories
    (user-error "Set `fdbk-queue-repositories' to the clones the queue should look in"))
  (unless fdbk-queue--refreshing
    (setq fdbk-queue--refreshing t)
    (fdbk-queue--render-buffer)
    (let ((default-directory (expand-file-name "~/")))
      (condition-case err
          (fdbk--call-async
           (append (list "queue" "--days" (number-to-string fdbk-queue-days))
                   (mapcar #'expand-file-name fdbk-queue-repositories))
           #'fdbk-queue--receive
           #'fdbk-queue--fail)
        (error (fdbk-queue--fail (error-message-string err)))))))

(defun fdbk-queue--start-review (item)
  "Start or resume a review of the agent work ITEM and show it."
  (let* ((default-directory (file-name-as-directory (plist-get item :dir)))
         (review (if-let* ((id (plist-get (plist-get item :review) :id)))
                     (fdbk--call (list "show" "--review" id))
                   (fdbk--call (append (list "start" "--title" (plist-get item :title) "--")
                                       (plist-get item :spec))))))
    (fdbk--open-review review)))

(defun fdbk-queue-review ()
  "Start or resume a review of the item at point.
Returns the review buffer for agent work; pull requests are fetched in
the background."
  (interactive)
  (let ((item (fdbk-queue--item-at-point)))
    (if (equal (plist-get item :kind) "agent")
        (fdbk-queue--start-review item)
      (let ((default-directory (file-name-as-directory (plist-get item :dir))))
        (message "Fetching pull request %s..." (plist-get item :url))
        (fdbk--call-async (list "github" "start" (plist-get item :url)) #'fdbk--open-review)))))

(defun fdbk-queue-diff ()
  "Show the diff of the agent work at point without starting a review."
  (interactive)
  (let ((item (fdbk-queue--item-at-point)))
    (unless (equal (plist-get item :kind) "agent")
      (user-error "Use RET to review a pull request"))
    (let ((default-directory (file-name-as-directory (plist-get item :dir))))
      (fdbk--show-spec (plist-get item :spec)))))

(defun fdbk-queue-browse ()
  "Open the pull request at point in a browser."
  (interactive)
  (browse-url (or (plist-get (fdbk-queue--item-at-point) :url)
                  (user-error "Not a pull request"))))

(defun fdbk-queue-magit-status ()
  "Show the Magit status of the item's repository or worktree."
  (interactive)
  (magit-status-setup-buffer (plist-get (fdbk-queue--item-at-point) :dir)))

(defun fdbk-queue-agent-session ()
  "Open the agent session behind the item at point."
  (interactive)
  (unless (fboundp 'opencode-open-session-by-id)
    (user-error "Opening sessions needs emacs-opencode"))
  (let* ((sessions (or (plist-get (fdbk-queue--item-at-point) :sessions)
                       (user-error "No agent session for this item")))
         (choices (mapcar (lambda (s)
                            (cons (format "%s  %s" (fdbk-queue--age-label s)
                                          (let ((title (plist-get s :title)))
                                            (if (string-empty-p title) (plist-get s :id) title)))
                                  s))
                          sessions))
         (session (if (cdr choices)
                      (cdr (assoc (completing-read "Session: " choices nil t) choices))
                    (cdar choices))))
    (opencode-open-session-by-id (plist-get session :id) (plist-get session :directory))))

(defun fdbk-queue-dismiss ()
  "Hide the item at point until it changes, or bring back a dismissed item."
  (interactive)
  (let* ((item (fdbk-queue--item-at-point))
         (id (plist-get item :id))
         (section (magit-current-section))
         (next (or (car (magit-section-siblings section 'next))
                   (car (magit-section-siblings section 'prev)))))
    (setf (alist-get id fdbk-queue--dismissed nil t #'equal)
          (unless (fdbk-queue--dismissed-p item) (plist-get item :version)))
    (fdbk-queue--save-dismissed)
    (fdbk-queue--render (and next (plist-get (oref next value) :id)))))

;;; Mode

(defvar-keymap fdbk-queue-mode-map
  :doc "Keymap for `fdbk-queue-mode'."
  :parent magit-section-mode-map
  "g" #'fdbk-queue-refresh
  "q" #'quit-window)

(define-derived-mode fdbk-queue-mode magit-section-mode "Review Queue"
  "List agent work and pull requests waiting for your review.
\\{fdbk-queue-mode-map}
On an item:
\\{fdbk-queue-item-section-map}"
  (setq-local truncate-lines t)
  (unless fdbk-queue--dismissed (fdbk-queue--load-dismissed)))

(declare-function evil-define-key* "evil-core")
(declare-function evil-set-initial-state "evil-core")

(with-eval-after-load 'evil
  (evil-set-initial-state 'fdbk-queue-mode 'motion)
  (evil-define-key* 'motion fdbk-queue-mode-map
    (kbd "TAB") #'magit-section-toggle
    "gr" #'fdbk-queue-refresh
    "q" #'quit-window))

;;;###autoload
(defun fdbk-queue ()
  "Show agent work and pull requests waiting for your review."
  (interactive)
  (let ((buffer (get-buffer-create fdbk-queue--buffer-name)))
    (with-current-buffer buffer
      (unless (derived-mode-p 'fdbk-queue-mode) (fdbk-queue-mode))
      (fdbk-queue--render))
    (pop-to-buffer-same-window buffer)
    (fdbk-queue-refresh)))

(provide 'fdbk-queue)
;;; fdbk-queue.el ends here
