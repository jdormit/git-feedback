;;; gur.el --- Magit frontend for git-universal-review  -*- lexical-binding: t; -*-

;; Author: Jeremy Dormitzer <jeremy.dormitzer@gmail.com>
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1") (magit "4.0") (transient "0.6"))
;; Keywords: git tools vc

;;; Commentary:

;; Review any diff Magit can show.  `gur-start' in a Magit diff or
;; revision buffer starts (or resumes) a review of that diff; comment
;; threads are then shown inline under the lines they belong to.
;; `gur-dispatch' (bound to C-c C-r in review buffers) lists the review
;; commands.
;;
;; Reviews are stored and manipulated by the `git-universal-review'
;; command-line tool, which this package calls with --json.  Other
;; frontends (agents, GitHub sync) edit the same review, and the buffer
;; re-renders when the review file changes.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'filenotify)
(require 'magit)
(require 'magit-diff)
(require 'magit-section)
(require 'transient)

;;; Customization

(defgroup gur nil
  "Review any git diff with git-universal-review."
  :group 'magit-extensions)

(defcustom gur-program "git-universal-review"
  "The git-universal-review executable."
  :type 'string)

(defcustom gur-program-args nil
  "Arguments placed before every git-universal-review subcommand.
Useful when `gur-program' is an interpreter such as bun."
  :type '(repeat string))

(defface gur-heading
  '((t :inherit magit-section-heading
       :weight bold
       :box (:line-width (1 . 1) :style released-button)))
  "Face for review thread headings.")

(defface gur-comment-text
  '((((class color) (background light))
     :inherit default :background "#f0f4ff" :foreground "#1f2a44" :extend t)
    (((class color) (background dark))
     :inherit default :background "#1b2538" :foreground "#d7e3ff" :extend t)
    (t :inherit default :inverse-video t))
  "Face for review comment bodies.")

(defface gur-comment-heading
  '((((class color) (background light))
     :inherit gur-comment-text :background "#dbe7ff" :foreground "#0f2f66" :weight bold :extend t)
    (((class color) (background dark))
     :inherit gur-comment-text :background "#243655" :foreground "#ffffff" :weight bold :extend t)
    (t :inherit gur-comment-text :weight bold))
  "Face for the author line of a review comment.")

(defface gur-resolved
  '((t :inherit shadow :extend t))
  "Face for resolved threads.")

(defface gur-label
  '((t :inherit warning :weight bold))
  "Face for status labels such as \"outdated\" and \"pending\".")

(defface gur-commented-line
  '((t :inherit highlight :extend t))
  "Face for diff lines that have an unresolved thread.")

;;; Command-line tool

(defun gur--parse-json (string)
  "Parse STRING as JSON into plists."
  (json-parse-string string :object-type 'plist :array-type 'list
                     :null-object nil :false-object nil))

(defun gur--call (args &optional input)
  "Run git-universal-review with ARGS, feeding INPUT on stdin.
Returns the parsed JSON output.  Signals a `user-error' on failure."
  (let ((stderr (make-temp-file "gur-stderr")))
    (unwind-protect
        (with-temp-buffer
          (let* ((out (current-buffer))
                 (cmd (append gur-program-args (list "--json") args))
                 (code (if input
                           (with-temp-buffer
                             (insert input)
                             (apply #'call-process-region (point-min) (point-max)
                                    gur-program nil (list out stderr) nil cmd))
                         (apply #'call-process gur-program nil (list out stderr) nil cmd))))
            (unless (eq code 0)
              (user-error "%s" (string-trim
                                (with-temp-buffer
                                  (insert-file-contents stderr)
                                  (buffer-string)))))
            (gur--parse-json (buffer-string))))
      (delete-file stderr))))

(defun gur--call-async (args callback)
  "Run git-universal-review with ARGS asynchronously.
Call CALLBACK with the parsed JSON output on success."
  (let* ((out (generate-new-buffer " *gur-out*"))
         (err (generate-new-buffer " *gur-err*")))
    (make-process
     :name "git-universal-review"
     :buffer out
     :stderr err
     :command (append (list gur-program) gur-program-args (list "--json") args)
     :sentinel
     (lambda (proc _event)
       (unless (process-live-p proc)
         (unwind-protect
             (if (eq (process-exit-status proc) 0)
                 (funcall callback (gur--parse-json (with-current-buffer out (buffer-string))))
               (message "git-universal-review: %s"
                        (string-trim (with-current-buffer err (buffer-string)))))
           (kill-buffer out)
           (kill-buffer err)))))))

;;; Specs

(defun gur--buffer-spec ()
  "Return the git diff arguments that reproduce the current Magit buffer."
  (when (member "-R" magit-buffer-diff-args)
    (user-error "Reverse diffs are not supported; toggle -R off first"))
  (when (equal magit-buffer-diff-typearg "--no-index")
    (user-error "--no-index diffs are not supported"))
  (append
   (cond ((derived-mode-p 'magit-revision-mode)
          (list (concat (magit-rev-parse magit-buffer-revision) "^!")))
         (magit-buffer-diff-range (list magit-buffer-diff-range)))
   (and (equal magit-buffer-diff-typearg "--cached") (list "--cached"))
   (and magit-buffer-diff-files (cons "--" magit-buffer-diff-files))))

(defun gur--show-spec (spec)
  "Show the diff described by the git diff arguments SPEC; return its buffer."
  (let* ((split (or (seq-position spec "--") (length spec)))
         (head (seq-take spec split))
         (files (seq-drop spec (1+ split)))
         (cached (seq-some (lambda (a) (member a '("--cached" "--staged"))) head))
         (merge-base (member "--merge-base" head))
         (revs (seq-remove (lambda (a) (string-prefix-p "-" a)) head))
         (args (car (magit-diff-arguments 'magit-diff-mode))))
    (pcase-exhaustive revs
      ('()
       (magit-diff-setup-buffer nil (and cached "--cached") args files
                                (if cached 'staged 'unstaged)))
      (`(,rev)
       (if (string-suffix-p "^!" rev)
           (magit-revision-setup-buffer (substring rev 0 -2) args files)
         (magit-diff-setup-buffer rev (and cached "--cached") args files
                                  (if (string-match-p "\\.\\." rev) 'committed
                                    (if cached 'staged 'committed)))))
      (`(,a ,b)
       (magit-diff-setup-buffer (format (if merge-base "%s...%s" "%s..%s") a b)
                                nil args files 'committed)))))

;;; Buffer state

(defvar-local gur--review nil
  "The review shown in this buffer, as returned by `gur show --json'.")

(defvar-local gur--review-id nil
  "Id of the review attached to this buffer.")

(defvar-local gur--watch nil
  "File notification descriptor for the review's directory.")

(defvar-local gur--watch-timer nil
  "Timer that debounces re-rendering after the review file changes.")

(defvar-local gur--overlays nil
  "Line highlight overlays added by gur.")

(defun gur--review-arg ()
  "Return the --review argument for the review in this buffer."
  (list "--review" gur--review-id))

(defun gur--latest-revision ()
  "Return the latest revision number of the review in this buffer."
  (plist-get (car (last (plist-get (plist-get gur--review :target) :revisions))) :n))

(defun gur--threads ()
  "Return the threads of the review in this buffer."
  (plist-get gur--review :threads))

(defun gur--thread (id)
  "Return the thread with ID."
  (seq-find (lambda (thread) (equal (plist-get thread :id) id)) (gur--threads)))

;;; Minor mode

(defvar-keymap gur-mode-map
  :doc "Keymap for `gur-mode'."
  "C-c C-r" #'gur-dispatch)

(defvar-keymap gur-thread-section-map
  :doc "Keymap for review thread sections."
  :parent gur-mode-map
  "RET" #'gur-reply)

(defvar-keymap gur-summary-section-map
  :doc "Keymap for the review summary section."
  :parent gur-mode-map)

(defclass gur-thread-section (magit-section)
  ((keymap :initform 'gur-thread-section-map))
  "Magit section for a review thread.")

(defclass gur-summary-section (magit-section)
  ((keymap :initform 'gur-summary-section-map))
  "Magit section summarizing the review and listing threads not shown inline.")

(defun gur--lighter ()
  "Return the mode-line lighter for `gur-mode'."
  (let ((open (seq-count (lambda (thread) (not (plist-get thread :resolved))) (gur--threads))))
    (if (> open 0) (format " Review[%d]" open) " Review")))

(define-minor-mode gur-mode
  "Show and edit a git-universal-review review in a Magit diff buffer.
\\{gur-mode-map}"
  :lighter (:eval (gur--lighter))
  (if gur-mode
      (progn
        (add-hook 'magit-refresh-buffer-hook #'gur--after-refresh nil t)
        (add-hook 'change-major-mode-hook #'gur--unwatch nil t))
    (remove-hook 'magit-refresh-buffer-hook #'gur--after-refresh t)
    (remove-hook 'change-major-mode-hook #'gur--unwatch t)
    (gur--unwatch)
    (gur--clear-rendered)
    (setq gur--review nil gur--review-id nil)))

(defun gur--assert ()
  "Signal a user error unless this buffer shows a review."
  (unless (and gur-mode gur--review-id)
    (user-error "No review in this buffer; start one with `gur-start'")))

(defun gur--after-refresh ()
  "Re-render the review after Magit refreshes the buffer."
  (when gur-mode
    (if (equal (ignore-errors (gur--buffer-spec))
               (plist-get (plist-get gur--review :target) :spec))
        (gur--render t)
      (gur-mode -1)
      (message "This buffer now shows a different diff; review detached"))))

;;; Watching for changes by other frontends

(defun gur--review-file ()
  "Return the file the review in this buffer is stored in."
  (expand-file-name (concat "universal-review/reviews/" gur--review-id ".json")
                    (magit-rev-parse "--path-format=absolute" "--git-common-dir")))

(defun gur--unwatch ()
  "Stop watching the review file."
  (when gur--watch
    (file-notify-rm-watch gur--watch)
    (setq gur--watch nil)))

(defun gur--watch-review ()
  "Re-render this buffer when another process changes the review."
  (gur--unwatch)
  (let* ((buffer (current-buffer))
         (file (gur--review-file))
         (name (file-name-nondirectory file)))
    (when (file-directory-p (file-name-directory file))
      (setq gur--watch
            (file-notify-add-watch
             (file-name-directory file) '(change)
             (lambda (event)
               (when (and (buffer-live-p buffer)
                          (seq-some (lambda (f) (and (stringp f) (equal (file-name-nondirectory f) name)))
                                    (cddr event)))
                 (with-current-buffer buffer
                   (when (timerp gur--watch-timer) (cancel-timer gur--watch-timer))
                   (setq gur--watch-timer
                         (run-with-idle-timer 0.3 nil #'gur--rerender-if-changed buffer))))))))))

(defun gur--rerender-if-changed (buffer)
  "Re-render BUFFER if its review was updated since it was last drawn."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when gur-mode
        (let ((review (ignore-errors (gur--call (append '("show" "--no-refresh") (gur--review-arg))))))
          (when (and review (not (equal (plist-get review :updatedAt)
                                        (plist-get gur--review :updatedAt))))
            (gur--draw review)))))))

;;; Diff positions
;;
;; Threads are anchored to (path, side, line), where side is "old" (the
;; diff's base) or "new" (its head) and line is a line number in that
;; version of the file.  These functions translate between anchors and
;; buffer positions by walking hunk sections, skipping inserted review text.

(defun gur--rendered-line-p ()
  "Return non-nil if the current line was inserted by gur."
  (get-text-property (line-beginning-position) 'gur-rendered))

(defun gur--file-path (file side)
  "Return the path of FILE section on SIDE (\"old\" or \"new\")."
  (or (and (equal side "old") (oref file source)) (oref file value)))

(defun gur--location-at (pos)
  "Return (:path :side :line :hunk) for the diff line at POS, or nil."
  (save-excursion
    (goto-char pos)
    (let ((section (magit-current-section)))
      (when (and (magit-hunk-section-p section)
                 (not (oref section combined))
                 (>= (line-beginning-position) (oref section content))
                 (not (gur--rendered-line-p)))
        (let ((target (line-beginning-position))
              (file (oref section parent))
              (old (car (oref section from-range)))
              (new (car (oref section to-range))))
          (goto-char (oref section content))
          (catch 'loc
            (while (< (point) (oref section end))
              (unless (gur--rendered-line-p)
                (let ((prefix (char-after)))
                  (when (= (point) target)
                    (throw 'loc
                           (pcase prefix
                             (?- (list :path (gur--file-path file "old") :side "old" :line old :hunk section))
                             (?\\ nil)
                             (_ (list :path (gur--file-path file "new") :side "new" :line new :hunk section)))))
                  (pcase prefix
                    (?+ (cl-incf new))
                    (?- (cl-incf old))
                    (?\\ nil)
                    (_ (cl-incf new) (cl-incf old)))))
              (forward-line 1))
            nil))))))

(defun gur--region-location (beg end)
  "Return the anchor for the diff lines between BEG and END.
A line counts as selected when the region covers its beginning, so a
region ending at the start of a line excludes that line.  Inserted
review text is skipped.  The anchor uses the side of the last selected
line; the range starts at the first selected line on that side."
  (let (locations)
    (save-excursion
      (goto-char beg)
      (let ((first (line-beginning-position)))
        (goto-char first)
        (while (and (not (eobp)) (or (= (point) first) (< (point) end)))
          (when-let* ((loc (gur--location-at (point))))
            (push loc locations))
          (forward-line 1))))
    (unless locations
      (user-error "Comments can only be placed on diff lines"))
    (let ((last (car locations)))
      (unless (seq-every-p (lambda (loc) (eq (plist-get loc :hunk) (plist-get last :hunk))) locations)
        (user-error "Comment region must stay within a single hunk"))
      (let* ((same-side (seq-filter (lambda (loc) (equal (plist-get loc :side) (plist-get last :side)))
                                    locations))
             (start (apply #'min (mapcar (lambda (loc) (plist-get loc :line)) same-side))))
        (append (list :path (plist-get last :path) :side (plist-get last :side) :line (plist-get last :line))
                (and (< start (plist-get last :line)) (list :start-line start)))))))

(defun gur--find-in-hunk (hunk side line)
  "Return the position of SIDE:LINE within HUNK, or nil."
  (pcase-let ((`(,old ,old-count) (oref hunk from-range))
              (`(,new ,new-count) (oref hunk to-range)))
    (when (if (equal side "old")
              (and (>= line old) (< line (+ old (max (or old-count 1) 1))))
            (and (>= line new) (< line (+ new (max (or new-count 1) 1)))))
      (save-excursion
        (goto-char (oref hunk content))
        (catch 'pos
          (while (< (point) (oref hunk end))
            (unless (gur--rendered-line-p)
              (pcase (char-after)
                (?+ (when (and (equal side "new") (= new line)) (throw 'pos (point)))
                    (cl-incf new))
                (?- (when (and (equal side "old") (= old line)) (throw 'pos (point)))
                    (cl-incf old))
                (?\\ nil)
                (_ (when (or (and (equal side "new") (= new line))
                             (and (equal side "old") (= old line)))
                     (throw 'pos (point)))
                   (cl-incf new) (cl-incf old))))
            (forward-line 1))
          nil)))))

(defun gur--file-sections ()
  "Return the file sections of the current Magit diff buffer."
  (seq-filter #'magit-file-section-p (oref magit-root-section children)))

(defun gur--find-position (path side line)
  "Return the position of the diff line for PATH, SIDE and LINE, or nil."
  (seq-some (lambda (file)
              (and (equal (gur--file-path file side) path)
                   (seq-some (lambda (hunk)
                               (and (magit-hunk-section-p hunk)
                                    (not (oref hunk combined))
                                    (gur--find-in-hunk hunk side line)))
                             (oref file children))))
            (gur--file-sections)))

(defun gur--diff-hunk-line (orig section goto-from)
  "Call ORIG with SECTION and GOTO-FROM, ignoring inserted review lines."
  (if (not (bound-and-true-p gur-mode))
      (funcall orig section goto-from)
    (save-excursion
      (goto-char (line-beginning-position))
      (with-slots (content from-range to-range) section
        (when (or from-range to-range)
          (when (< (point) content)
            (goto-char content)
            (re-search-forward "^[-+]"))
          (let ((target (point))
                (offset 0))
            (goto-char content)
            (while (< (point) target)
              (unless (or (gur--rendered-line-p)
                          (eq (char-after) (if goto-from ?+ ?-)))
                (cl-incf offset))
              (forward-line 1))
            (+ (car (if goto-from from-range to-range)) offset)))))))

(defun gur--strip-before-apply (orig &rest args)
  "Remove review text before Magit reads a patch; call ORIG with ARGS.
Magit refreshes the buffer after applying, which renders the review again."
  (when (bound-and-true-p gur-mode)
    (gur--clear-rendered))
  (apply orig args))

(advice-add 'magit-diff-hunk-line :around #'gur--diff-hunk-line)
(advice-add 'magit-apply--section-content :around #'gur--strip-before-apply)
(advice-add 'magit-diff-hunk-region-patch :around #'gur--strip-before-apply)

;;; Rendering

(defun gur--clear-rendered ()
  "Delete all inserted review text and overlays."
  (mapc #'delete-overlay gur--overlays)
  (setq gur--overlays nil)
  (when magit-root-section
    (gur--prune-sections magit-root-section))
  (let ((inhibit-read-only t))
    (while-let ((beg (text-property-any (point-min) (point-max) 'gur-rendered t)))
      (delete-region beg (or (next-single-property-change beg 'gur-rendered)
                             (point-max))))))

(defun gur--prune-sections (section)
  "Remove gur sections from the children of SECTION, recursively."
  (oset section children (seq-remove #'gur--rendered-section-p (oref section children)))
  (mapc #'gur--prune-sections (oref section children)))

(defun gur--rendered-section-p (section)
  "Return non-nil if SECTION was inserted by gur."
  (and section (memq (eieio-object-class section) '(gur-thread-section gur-summary-section))))

(defun gur--apply-faces (&rest _)
  "Reapply review faces after Magit repaints hunks."
  (when (bound-and-true-p gur-mode)
    (let ((inhibit-read-only t))
      (let ((pos (point-min)))
        (while-let ((beg (text-property-not-all pos (point-max) 'gur-face nil)))
          (setq pos (or (next-single-property-change beg 'gur-face) (point-max)))
          (put-text-property beg pos 'face (get-text-property beg 'gur-face)))))))

(advice-add 'magit-section-paint :after #'gur--apply-faces)

(cl-defmethod magit-section-highlight ((_section gur-thread-section))
  "Keep review faces intact when point enters a thread."
  (gur--apply-faces))

(cl-defmethod magit-section-highlight ((_section gur-summary-section))
  "Keep review faces intact when point enters the summary."
  (gur--apply-faces))

(defun gur--line (text face &rest props)
  "Return TEXT as a full rendered line with FACE and PROPS."
  (apply #'propertize (concat text "\n") 'face face 'gur-face face props))

(defun gur--format-time (iso)
  "Format the ISO 8601 timestamp ISO for display."
  (if (and (stringp iso) (>= (length iso) 16))
      (replace-regexp-in-string "T" " " (substring iso 0 16))
    (or iso "")))

(defun gur--location-label (thread)
  "Return a short description of where THREAD is anchored."
  (let* ((anchor (plist-get thread :anchor))
         (pos (unless (plist-get thread :outdated) (plist-get thread :position)))
         (path (or (plist-get pos :path) (plist-get anchor :path))))
    (pcase (plist-get anchor :kind)
      ("review" "review")
      ("file" path)
      (_ (let ((line (or (plist-get pos :line) (plist-get anchor :line)))
               (start (if pos (plist-get pos :startLine) (plist-get anchor :startLine))))
           (format "%s:%s%s (%s)" path (if start (format "%d-" start) "") line
                   (plist-get anchor :side)))))))

(defun gur--insert-thread (thread &optional label)
  "Insert THREAD as a section at point.  Prefix the heading with LABEL."
  (let* ((resolved (plist-get thread :resolved))
         (linked (plist-get gur--review :github))
         (text-face (if resolved 'gur-resolved 'gur-comment-text))
         (head-face (if resolved 'gur-resolved 'gur-comment-heading))
         (status (string-join
                  (delq nil (list (if resolved "resolved" "unresolved")
                                  (and (plist-get thread :outdated) "outdated")))
                  ", ")))
    (magit-insert-section (gur-thread-section (plist-get thread :id) resolved)
      (magit-insert-heading
        (gur--line (format "    %sThread %s · %s" (if label (concat label " · ") "")
                           (plist-get thread :id) status)
                   'gur-heading))
      (when (plist-get thread :outdated)
        (let ((lines (plist-get (plist-get thread :anchor) :lines)))
          (when lines
            (insert (gur--line "      Originally on:" text-face))
            (dolist (line lines)
              (insert (gur--line (concat "      │ " line) text-face))))))
      (dolist (comment (plist-get thread :comments))
        (let* ((author (plist-get comment :author))
               (agent (equal (plist-get author :kind) "agent"))
               (pending (and linked (not (plist-get comment :github)))))
          (insert (gur--line (concat "    " (plist-get author :name)
                                     (if agent " (agent)" "")
                                     " · " (gur--format-time (plist-get comment :createdAt))
                                     (if pending " · not on GitHub yet" ""))
                             head-face 'gur-comment (plist-get comment :id)))
          (dolist (line (split-string (plist-get comment :body) "\n"))
            (insert (gur--line (concat "      " line) text-face 'gur-comment (plist-get comment :id)))))))))

(defun gur--insert-after-line (pos thread)
  "Insert THREAD after the diff line at POS, inside that line's hunk."
  (let ((hunk (save-excursion (goto-char pos) (magit-current-section)))
        (inhibit-read-only t))
    (save-excursion
      (goto-char pos)
      (forward-line 1)
      (while (and (gur--rendered-line-p) (not (eobp)))
        (forward-line 1))
      (let ((beg (point)))
        (let ((magit-insert-section--parent hunk)
              (magit-insert-section--current hunk))
          (gur--insert-thread thread))
        (put-text-property beg (point) 'gur-rendered t)))))

(defun gur--insert-summary (threads)
  "Insert the review summary, listing THREADS that are not shown inline."
  (let* ((inhibit-read-only t)
         (all (gur--threads))
         (open (seq-count (lambda (thread) (not (plist-get thread :resolved))) all))
         (github (plist-get gur--review :github)))
    (save-excursion
      (goto-char (point-min))
      (let ((beg (point)))
        (let ((magit-insert-section--parent magit-root-section)
              (magit-insert-section--current magit-root-section))
          (magit-insert-section (gur-summary-section 'gur-summary)
            (magit-insert-heading
              (gur--line (format "Review %s: %s · %d open of %d thread(s) · revision %s"
                                 (plist-get gur--review :id) (plist-get gur--review :title)
                                 open (length all) (gur--latest-revision))
                         'gur-heading))
            (when github
              (insert (gur--line (concat "  " (plist-get github :url)) 'gur-comment-text)))
            (dolist (thread threads)
              (gur--insert-thread thread (gur--location-label thread)))
            (insert (gur--line "" 'default))))
        (put-text-property beg (point) 'gur-rendered t)))))

(defun gur--highlight (beg end thread)
  "Highlight diff lines from BEG to END that THREAD comments on."
  (let ((ov (make-overlay beg (save-excursion (goto-char end) (min (point-max) (1+ (line-end-position)))))))
    (overlay-put ov 'face 'gur-commented-line)
    (overlay-put ov 'gur-thread (plist-get thread :id))
    (push ov gur--overlays)))

(defun gur--inline-position (thread)
  "Return the buffer position of THREAD's last anchored line, or nil."
  (let ((pos (plist-get thread :position)))
    (and (not (plist-get thread :outdated))
         (equal (plist-get pos :revision) (gur--latest-revision))
         (plist-get pos :line)
         (gur--find-position (plist-get pos :path) (plist-get pos :side) (plist-get pos :line)))))

(defun gur--draw (review)
  "Draw REVIEW into the current buffer."
  (setq gur--review review)
  (gur--clear-rendered)
  (let (elsewhere)
    (dolist (thread (gur--threads))
      (if-let* ((pos (gur--inline-position thread)))
          (let* ((p (plist-get thread :position))
                 (start (and (plist-get p :startLine)
                             (gur--find-position (plist-get p :path) (plist-get p :side)
                                                 (plist-get p :startLine)))))
            (unless (plist-get thread :resolved)
              (gur--highlight (or start pos) pos thread))
            (gur--insert-after-line pos thread))
        (push thread elsewhere)))
    (gur--insert-summary (nreverse elsewhere)))
  (setq magit-section-highlight-force-update t)
  (gur--apply-faces)
  (force-mode-line-update))

(defun gur--render (&optional refresh)
  "Fetch the review and draw it.  With REFRESH, re-resolve its diff first."
  (when (and gur-mode gur--review-id)
    (condition-case err
        (gur--draw (gur--call (append (list "show") (unless refresh '("--no-refresh"))
                                      (gur--review-arg))))
      (user-error (message "gur: %s" (error-message-string err))))))

;;; Finding things at point

(defun gur--thread-section-at-point ()
  "Return the thread section at point, or nil."
  (let ((section (magit-current-section)))
    (while (and section (not (object-of-class-p section 'gur-thread-section)))
      (setq section (oref section parent)))
    section))

(defun gur--thread-id-at-point ()
  "Return the id of the thread at point or anchored on this line, or nil."
  (or (when-let* ((section (gur--thread-section-at-point))) (oref section value))
      (seq-some (lambda (ov) (overlay-get ov 'gur-thread))
                (overlays-at (line-beginning-position)))))

(defun gur--read-thread ()
  "Return the thread id at point, or signal a user error."
  (or (gur--thread-id-at-point) (user-error "No review thread here")))

(defun gur--read-comment (&optional predicate)
  "Return the id of the comment at point, asking when it is ambiguous.
Only comments satisfying PREDICATE are offered."
  (or (get-text-property (point) 'gur-comment)
      (let* ((thread (gur--thread (gur--read-thread)))
             (comments (seq-filter (or predicate #'identity) (plist-get thread :comments))))
        (pcase comments
          ('() (user-error "No matching comments in this thread"))
          (`(,only) (plist-get only :id))
          (_ (let* ((choices (mapcar (lambda (c)
                                       (cons (format "%s: %s" (plist-get (plist-get c :author) :name)
                                                     (car (split-string (plist-get c :body) "\n")))
                                             (plist-get c :id)))
                                     comments)))
               (cdr (assoc (completing-read "Comment: " choices nil t) choices))))))))

(defun gur--comment (id)
  "Return the comment with ID."
  (seq-some (lambda (thread)
              (seq-find (lambda (c) (equal (plist-get c :id) id)) (plist-get thread :comments)))
            (gur--threads)))

;;; Composing comments

(defvar-local gur--edit-callback nil
  "Function called with the text of a confirmed comment.")

(defvar-local gur--edit-allow-empty nil
  "Non-nil if the text being written may be empty.")

(defvar-keymap gur-edit-mode-map
  :doc "Keymap for `gur-edit-mode'."
  "C-c C-c" #'gur-edit-confirm
  "C-c C-k" #'gur-edit-cancel)

(define-minor-mode gur-edit-mode
  "Minor mode for writing a review comment.
\\{gur-edit-mode-map}"
  :lighter " Review-Edit")

(defun gur--edit (title initial callback &optional allow-empty)
  "Pop up a buffer titled TITLE, prefilled with INITIAL.
Call CALLBACK with the text when the user confirms it.  Unless
ALLOW-EMPTY, refuse to confirm empty text."
  (let ((buffer (generate-new-buffer (format "*gur %s*" title))))
    (with-current-buffer buffer
      (cond ((fboundp 'gfm-mode) (gfm-mode))
            ((fboundp 'markdown-mode) (markdown-mode))
            (t (text-mode)))
      (when initial (insert initial))
      (gur-edit-mode 1)
      (setq gur--edit-callback callback
            gur--edit-allow-empty allow-empty)
      (setq header-line-format
            (substitute-command-keys
             (format "%s · \\[gur-edit-confirm] to confirm, \\[gur-edit-cancel] to cancel" title))))
    (pop-to-buffer buffer)))

(defun gur-edit-confirm ()
  "Confirm the comment being written."
  (interactive)
  (let ((callback gur--edit-callback)
        (text (string-trim (buffer-substring-no-properties (point-min) (point-max)))))
    (unless callback (user-error "Not in a gur edit buffer"))
    (when (and (string-empty-p text) (not gur--edit-allow-empty))
      (user-error "The comment is empty"))
    (quit-window t)
    (funcall callback text)))

(defun gur-edit-cancel ()
  "Discard the comment being written."
  (interactive)
  (quit-window t)
  (message "Comment discarded"))

(defun gur--mutate (args &optional input)
  "Run the review command ARGS with INPUT, then redraw the review buffer."
  (gur--call (append args (gur--review-arg)) input)
  (gur--render))

(defun gur--compose (title args &optional initial)
  "Write a comment titled TITLE and pass it to the review command ARGS.
INITIAL prefills the comment."
  (let ((buffer (current-buffer)))
    (gur--edit title initial
               (lambda (text)
                 (with-current-buffer buffer
                   (gur--mutate (append args '("--body-file" "-")) text))))))

;;; Commands

(defun gur-comment (beg end)
  "Comment on the diff line at point, or on the lines from BEG to END."
  (interactive (if (use-region-p)
                   (list (region-beginning) (region-end))
                 (list (line-beginning-position) (line-beginning-position))))
  (gur--assert)
  (let ((loc (gur--region-location beg end)))
    (deactivate-mark)
    (gur--compose
     (format "comment on %s:%s" (plist-get loc :path) (plist-get loc :line))
     (append (list "comment" "--path" (plist-get loc :path)
                   "--side" (plist-get loc :side)
                   "--line" (number-to-string (plist-get loc :line))
                   "--revision" (number-to-string (gur--latest-revision)))
             (when-let* ((start (plist-get loc :start-line)))
               (list "--start-line" (number-to-string start)))))))

(defun gur-comment-file ()
  "Comment on the file at point as a whole."
  (interactive)
  (gur--assert)
  (let ((section (magit-current-section)))
    (while (and section (not (magit-file-section-p section)))
      (setq section (oref section parent)))
    (unless section (user-error "No file here"))
    (gur--compose (format "comment on %s" (oref section value))
                  (list "comment" "--path" (oref section value)
                        "--revision" (number-to-string (gur--latest-revision))))))

(defun gur-comment-review ()
  "Add a comment on the review as a whole."
  (interactive)
  (gur--assert)
  (gur--compose "review comment" (list "comment")))

(defun gur-reply ()
  "Reply to the thread at point."
  (interactive)
  (gur--assert)
  (let ((thread (gur--read-thread)))
    (gur--compose "reply" (list "reply" thread))))

(defun gur-edit-comment ()
  "Edit the comment at point."
  (interactive)
  (gur--assert)
  (let ((id (gur--read-comment)))
    (gur--compose "edit comment" (list "edit" id) (plist-get (gur--comment id) :body))))

(defun gur-delete-comment ()
  "Delete the comment at point."
  (interactive)
  (gur--assert)
  (let ((id (gur--read-comment (lambda (c) (not (plist-get c :github))))))
    (when (yes-or-no-p "Delete this comment? ")
      (gur--mutate (list "delete" id)))))

(defun gur-toggle-resolved ()
  "Resolve the thread at point, or reopen it if it is resolved."
  (interactive)
  (gur--assert)
  (let* ((id (gur--read-thread))
         (resolved (plist-get (gur--thread id) :resolved)))
    (gur--mutate (list (if resolved "unresolve" "resolve") id))))

(defun gur-refresh ()
  "Refresh the diff and move threads onto the current code."
  (interactive)
  (gur--assert)
  (magit-refresh))

(defun gur-close-review ()
  "Close the review and detach it from this buffer."
  (interactive)
  (gur--assert)
  (gur--call (append '("close") (gur--review-arg)))
  (gur-mode -1)
  (message "Review closed"))

(defun gur-delete-review ()
  "Delete the review and everything in it."
  (interactive)
  (gur--assert)
  (when (yes-or-no-p (format "Delete review %s and all its comments? " gur--review-id))
    (gur--call (append '("rm") (gur--review-arg)))
    (gur-mode -1)
    (message "Review deleted")))

(defun gur--attach (review)
  "Show REVIEW in the current Magit diff buffer."
  (unless (derived-mode-p 'magit-diff-mode)
    (user-error "Reviews can only be shown in Magit diff buffers"))
  (setq gur--review-id (plist-get review :id))
  (gur-mode 1)
  (gur--draw review)
  (gur--watch-review)
  (message (substitute-command-keys
            "Reviewing %s; \\[gur-dispatch] for review commands")
           (plist-get review :title)))

;;;###autoload
(defun gur-start (&optional title)
  "Start or resume a review of the diff in the current Magit buffer.
With a prefix argument, ask for a TITLE."
  (interactive (list (and current-prefix-arg (read-string "Review title: "))))
  (unless (derived-mode-p 'magit-diff-mode)
    (user-error "Run this in a Magit diff or revision buffer"))
  (let ((review (gur--call (append '("start") (and title (list "--title" title))
                                   (cons "--" (gur--buffer-spec))))))
    (gur--attach review)))

(defun gur--open-review (review)
  "Show REVIEW's diff in a Magit buffer and attach the review to it."
  (let ((default-directory (file-name-as-directory
                            (plist-get (plist-get review :target) :worktree))))
    (with-current-buffer (gur--show-spec (plist-get (plist-get review :target) :spec))
      (gur--attach (gur--call (list "show" "--review" (plist-get review :id)))))))

;;;###autoload
(defun gur-open (&optional all)
  "Open an existing review of the current repository.
With a prefix argument ALL, include closed reviews."
  (interactive "P")
  (let* ((default-directory (magit-toplevel))
         (reviews (gur--call (append '("list") (and all '("--all"))))))
    (unless reviews (user-error "No reviews"))
    (let* ((choices (mapcar (lambda (r)
                              (cons (format "%s  %-6s %3d open  %s" (plist-get r :id) (plist-get r :status)
                                            (plist-get r :unresolved) (plist-get r :title))
                                    r))
                            reviews))
           (choice (cdr (assoc (completing-read "Review: " choices nil t) choices))))
      (when (equal (plist-get choice :status) "closed")
        (gur--call (list "reopen" "--review" (plist-get choice :id))))
      (gur--open-review (gur--call (list "show" "--no-refresh" "--review" (plist-get choice :id)))))))

;;; GitHub

(defun gur--default-pr ()
  "Return the pull request at point as a string, if Forge knows one."
  (when (and (featurep 'forge) (fboundp 'forge-current-pullreq))
    (when-let* ((pr (ignore-errors (funcall 'forge-current-pullreq))))
      (number-to-string (oref pr number)))))

;;;###autoload
(defun gur-github-review (pr)
  "Review the GitHub pull request PR (a number, owner/repo#N or URL)."
  (interactive (list (read-string "Pull request: " (gur--default-pr))))
  (let ((default-directory (or (magit-toplevel) (user-error "Not in a git repository"))))
    (message "Fetching pull request %s..." pr)
    (gur--call-async (list "github" "start" pr) #'gur--open-review)))

(defun gur-github-link (pr)
  "Link this review to the GitHub pull request PR."
  (interactive (list (read-string "Pull request: " (gur--default-pr))))
  (gur--assert)
  (gur--mutate (list "github" "link" pr)))

(defun gur--after-github (buffer message)
  "Return a callback that re-renders BUFFER and shows MESSAGE."
  (lambda (_result)
    (when (buffer-live-p buffer)
      (with-current-buffer buffer (gur--render)))
    (message "%s" message)))

(defun gur-github-pull ()
  "Import threads and comments from the linked pull request."
  (interactive)
  (gur--assert)
  (message "Pulling review comments from GitHub...")
  (gur--call-async (append '("github" "pull") (gur--review-arg))
                   (gur--after-github (current-buffer) "Pulled review comments from GitHub")))

(defun gur-github-push (event)
  "Send new comments, replies, edits and resolutions to GitHub.
EVENT is \"approve\", \"request-changes\" or \"comment\"."
  (interactive
   (list (pcase (read-char-choice "Submit as [a]pprove, [r]equest changes, [c]omment? " '(?a ?r ?c))
           (?a "approve") (?r "request-changes") (?c "comment"))))
  (gur--assert)
  (let ((buffer (current-buffer))
        (args (append (list "github" "push" "--event" event) (gur--review-arg))))
    (gur--edit (format "review summary (%s, optional)" event) nil
               (lambda (text)
                 (message "Pushing review to GitHub...")
                 (gur--call-async (append args (unless (string-empty-p text) (list "--body" text)))
                                  (gur--after-github buffer "Pushed review to GitHub")))
               t)))

;;; Transient

;;;###autoload (autoload 'gur-dispatch "gur" nil t)
(transient-define-prefix gur-dispatch ()
  "Review commands."
  [:description
   (lambda ()
     (if (and gur-mode gur--review)
         (format "Review %s: %s" gur--review-id (plist-get gur--review :title))
       "Review"))
   ["Comment"
    :if (lambda () gur-mode)
    ("c" "On line or region" gur-comment)
    ("f" "On file" gur-comment-file)
    ("C" "On whole review" gur-comment-review)
    ("r" "Reply to thread" gur-reply)
    ("e" "Edit comment" gur-edit-comment)
    ("k" "Delete comment" gur-delete-comment)
    ("x" "Resolve or reopen thread" gur-toggle-resolved)]
   ["Review"
    ("s" "Start or resume in this buffer" gur-start)
    ("o" "Open review..." gur-open)
    ("g" "Refresh" gur-refresh :if (lambda () gur-mode))
    ("Q" "Close review" gur-close-review :if (lambda () gur-mode))
    ("D" "Delete review" gur-delete-review :if (lambda () gur-mode))]
   ["GitHub"
    ("R" "Review pull request..." gur-github-review)
    ("L" "Link to pull request..." gur-github-link :if (lambda () gur-mode))
    ("p" "Pull comments" gur-github-pull :if (lambda () (plist-get gur--review :github)))
    ("P" "Push and submit..." gur-github-push :if (lambda () (plist-get gur--review :github)))]])

(provide 'gur)
;;; gur.el ends here
