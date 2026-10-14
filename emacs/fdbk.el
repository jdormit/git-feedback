;;; fdbk.el --- Magit frontend for git-feedback  -*- lexical-binding: t; -*-

;; Author: Jeremy Dormitzer <jeremy.dormitzer@gmail.com>
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1") (magit "4.0") (transient "0.6"))
;; Keywords: git tools vc

;;; Commentary:

;; Review any diff Magit can show.  `fdbk-start' in a Magit diff or
;; revision buffer starts (or resumes) a review of that diff; comment
;; threads are then shown inline under the lines they belong to.
;; `fdbk-dispatch' (bound to C-c C-r in review buffers) lists the review
;; commands.
;;
;; Reviews are stored and manipulated by the `fdbk'
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

(defgroup fdbk nil
  "Review any git diff with git-feedback."
  :group 'magit-extensions)

(defcustom fdbk-program "fdbk"
  "The git-feedback executable."
  :type 'string)

(defcustom fdbk-program-args nil
  "Arguments placed before every git-feedback subcommand.
Useful when `fdbk-program' is an interpreter such as bun."
  :type '(repeat string))

(defface fdbk-heading
  '((t :inherit magit-section-heading
       :weight bold
       :box (:line-width (1 . 1) :style released-button)))
  "Face for review thread headings.")

(defface fdbk-comment-text
  '((((class color) (background light))
     :inherit default :background "#f0f4ff" :foreground "#1f2a44" :extend t)
    (((class color) (background dark))
     :inherit default :background "#1b2538" :foreground "#d7e3ff" :extend t)
    (t :inherit default :inverse-video t))
  "Face for review comment bodies.")

(defface fdbk-comment-heading
  '((((class color) (background light))
     :inherit fdbk-comment-text :background "#dbe7ff" :foreground "#0f2f66" :weight bold :extend t)
    (((class color) (background dark))
     :inherit fdbk-comment-text :background "#243655" :foreground "#ffffff" :weight bold :extend t)
    (t :inherit fdbk-comment-text :weight bold))
  "Face for the author line of a review comment.")

(defface fdbk-resolved
  '((t :inherit shadow :extend t))
  "Face for resolved threads.")

(defface fdbk-label
  '((t :inherit warning :weight bold))
  "Face for status labels such as \"outdated\" and \"pending\".")

(defface fdbk-commented-line
  '((t :inherit highlight :extend t))
  "Face for diff lines that have an unresolved thread.")

;;; Command-line tool

(defun fdbk--parse-json (string)
  "Parse STRING as JSON into plists."
  (json-parse-string string :object-type 'plist :array-type 'list
                     :null-object nil :false-object nil))

(defun fdbk--process-environment ()
  "Return `process-environment' marking comments as written by a human.
Otherwise the CLI attributes comments to an agent when Emacs runs
inside an agent's shell."
  (cons "FDBK_AUTHOR_KIND=human" process-environment))

(defun fdbk--call (args &optional input)
  "Run git-feedback with ARGS, feeding INPUT on stdin.
Returns the parsed JSON output.  Signals a `user-error' on failure."
  (let ((stderr (make-temp-file "fdbk-stderr"))
        (process-environment (fdbk--process-environment)))
    (unwind-protect
        (with-temp-buffer
          (let* ((out (current-buffer))
                 (cmd (append fdbk-program-args (list "--json") args))
                 (code (if input
                           (with-temp-buffer
                             (insert input)
                             (apply #'call-process-region (point-min) (point-max)
                                    fdbk-program nil (list out stderr) nil cmd))
                         (apply #'call-process fdbk-program nil (list out stderr) nil cmd))))
            (unless (eq code 0)
              (user-error "%s" (string-trim
                                (with-temp-buffer
                                  (insert-file-contents stderr)
                                  (buffer-string)))))
            (fdbk--parse-json (buffer-string))))
      (delete-file stderr))))

(defun fdbk--call-async (args callback)
  "Run git-feedback with ARGS asynchronously.
Call CALLBACK with the parsed JSON output on success."
  (let* ((out (generate-new-buffer " *fdbk-out*"))
         (err (generate-new-buffer " *fdbk-err*"))
         (process-environment (fdbk--process-environment)))
    (make-process
     :name "git-feedback"
     :buffer out
     :stderr err
     :command (append (list fdbk-program) fdbk-program-args (list "--json") args)
     :sentinel
     (lambda (proc _event)
       (unless (process-live-p proc)
         (unwind-protect
             (if (eq (process-exit-status proc) 0)
                 (funcall callback (fdbk--parse-json (with-current-buffer out (buffer-string))))
               (message "git-feedback: %s"
                        (string-trim (with-current-buffer err (buffer-string)))))
           (kill-buffer out)
           (kill-buffer err)))))))

;;; Specs

(defun fdbk--buffer-spec ()
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

(defun fdbk--show-spec (spec)
  "Show the diff described by the git diff arguments SPEC; return its buffer."
  (let* ((split (or (seq-position spec "--") (length spec)))
         (head (seq-take spec split))
         (files (seq-drop spec (1+ split)))
         (cached (seq-some (lambda (a) (member a '("--cached" "--staged"))) head))
         (merge-base (member "--merge-base" head))
         (revs (seq-remove (lambda (a) (string-prefix-p "-" a)) head))
         (args (car (magit-diff-arguments 'magit-diff-mode))))
    (when (and merge-base (length< revs 2))
      (user-error "Magit cannot show a --merge-base diff against the working tree"))
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

(defvar-local fdbk--review nil
  "The review shown in this buffer, as returned by `fdbk show --json'.")

(defvar-local fdbk--review-id nil
  "Id of the review attached to this buffer.")

(defvar-local fdbk--shown-revision nil
  "Number of the review revision whose code this buffer's diff shows.")

(defvar-local fdbk--attached-spec nil
  "What `fdbk--buffer-spec' returned when the review was attached.")

(defvar-local fdbk--watch nil
  "File notification descriptor for the review's directory.")

(defvar-local fdbk--watch-timer nil
  "Timer that debounces re-rendering after the review file changes.")

(defvar-local fdbk--overlays nil
  "Line highlight overlays added by fdbk.")

(defun fdbk--review-arg ()
  "Return the --review argument for the review in this buffer."
  (list "--review" fdbk--review-id))

(defun fdbk--latest-revision ()
  "Return the latest revision number of the review in this buffer."
  (plist-get (car (last (plist-get (plist-get fdbk--review :target) :revisions))) :n))

(defun fdbk--revision ()
  "Return the revision whose code the diff in this buffer shows."
  (or fdbk--shown-revision (fdbk--latest-revision)))

(defun fdbk--threads ()
  "Return the threads of the review in this buffer."
  (plist-get fdbk--review :threads))

(defun fdbk--thread (id)
  "Return the thread with ID."
  (seq-find (lambda (thread) (equal (plist-get thread :id) id)) (fdbk--threads)))

;;; Minor mode

(defvar-keymap fdbk-mode-map
  :doc "Keymap for `fdbk-mode'."
  "C-c C-r" #'fdbk-dispatch)

(declare-function evil-define-key* "evil-core")
(declare-function evil-normalize-keymaps "evil-core")

;; evil-collection makes Magit's keymaps overriding maps, which shadow
;; ordinary minor mode keymaps in Evil states.
(with-eval-after-load 'evil
  (evil-define-key* '(normal visual motion insert emacs) fdbk-mode-map
    (kbd "C-c C-r") #'fdbk-dispatch))

(defvar-keymap fdbk-thread-section-map
  :doc "Keymap for review thread sections."
  :parent fdbk-mode-map
  "RET" #'fdbk-reply)

(defvar-keymap fdbk-summary-section-map
  :doc "Keymap for the review summary section."
  :parent fdbk-mode-map)

(defclass fdbk-thread-section (magit-section)
  ((keymap :initform 'fdbk-thread-section-map))
  "Magit section for a review thread.")

(defclass fdbk-summary-section (magit-section)
  ((keymap :initform 'fdbk-summary-section-map))
  "Magit section summarizing the review and listing threads not shown inline.")

(defun fdbk--lighter ()
  "Return the mode-line lighter for `fdbk-mode'."
  (let ((open (seq-count (lambda (thread) (not (plist-get thread :resolved))) (fdbk--threads))))
    (if (> open 0) (format " Review[%d]" open) " Review")))

(define-minor-mode fdbk-mode
  "Show and edit a git-feedback review in a Magit diff buffer.
\\{fdbk-mode-map}"
  :lighter (:eval (fdbk--lighter))
  (if fdbk-mode
      (progn
        (add-hook 'magit-refresh-buffer-hook #'fdbk--after-refresh nil t)
        (add-hook 'change-major-mode-hook #'fdbk--unwatch nil t)
        (add-hook 'kill-buffer-hook #'fdbk--unwatch nil t)
        (when (fboundp 'evil-normalize-keymaps) (evil-normalize-keymaps)))
    (remove-hook 'magit-refresh-buffer-hook #'fdbk--after-refresh t)
    (remove-hook 'change-major-mode-hook #'fdbk--unwatch t)
    (remove-hook 'kill-buffer-hook #'fdbk--unwatch t)
    (fdbk--unwatch)
    (fdbk--clear-rendered)
    (setq fdbk--review nil fdbk--review-id nil fdbk--shown-revision nil fdbk--attached-spec nil)))

(defun fdbk--assert ()
  "Signal a user error unless this buffer shows a review."
  (unless (and fdbk-mode fdbk--review-id)
    (user-error "No review in this buffer; start one with `fdbk-start'")))

(defun fdbk--after-refresh ()
  "Re-render the review after Magit refreshes the buffer."
  (when fdbk-mode
    (if (equal (ignore-errors (fdbk--buffer-spec)) fdbk--attached-spec)
        (fdbk--render t)
      (fdbk-mode -1)
      (message "This buffer now shows a different diff; review detached"))))

;;; Watching for changes by other frontends

(defun fdbk--review-file ()
  "Return the file the review in this buffer is stored in."
  (expand-file-name (concat "git-feedback/reviews/" fdbk--review-id ".json")
                    (magit-rev-parse "--path-format=absolute" "--git-common-dir")))

(defun fdbk--unwatch ()
  "Stop watching the review file."
  (when fdbk--watch
    (file-notify-rm-watch fdbk--watch)
    (setq fdbk--watch nil)))

(defun fdbk--watch-review ()
  "Re-render this buffer when another process changes the review."
  (fdbk--unwatch)
  (let* ((buffer (current-buffer))
         (file (fdbk--review-file))
         (name (file-name-nondirectory file)))
    (when (file-directory-p (file-name-directory file))
      (setq fdbk--watch
            (file-notify-add-watch
             (file-name-directory file) '(change)
             (lambda (event)
               (when (and (buffer-live-p buffer)
                          (seq-some (lambda (f) (and (stringp f) (equal (file-name-nondirectory f) name)))
                                    (cddr event)))
                 (with-current-buffer buffer
                   (when (timerp fdbk--watch-timer) (cancel-timer fdbk--watch-timer))
                   (setq fdbk--watch-timer
                         (run-with-idle-timer 0.3 nil #'fdbk--rerender-if-changed buffer))))))))))

(defun fdbk--rerender-if-changed (buffer)
  "Re-render BUFFER if its review was updated since it was last drawn."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when fdbk-mode
        (let ((review (ignore-errors (fdbk--call (append '("show" "--no-refresh") (fdbk--review-arg))))))
          (when (and review (not (equal (plist-get review :updatedAt)
                                        (plist-get fdbk--review :updatedAt))))
            (if (equal (plist-get (car (last (plist-get (plist-get review :target) :revisions))) :n)
                       fdbk--shown-revision)
                (fdbk--draw review)
              ;; The code moved on; redraw the diff, which renders the review again.
              (magit-refresh-buffer))))))))

;;; Diff positions
;;
;; Threads are anchored to (path, side, line), where side is "old" (the
;; diff's base) or "new" (its head) and line is a line number in that
;; version of the file.  These functions translate between anchors and
;; buffer positions by walking hunk sections, skipping inserted review text.

(defun fdbk--rendered-line-p ()
  "Return non-nil if the current line was inserted by fdbk."
  (get-text-property (line-beginning-position) 'fdbk-rendered))

(defun fdbk--file-path (file side)
  "Return the path of FILE section on SIDE (\"old\" or \"new\")."
  (or (and (equal side "old") (oref file source)) (oref file value)))

(defun fdbk--location-at (pos)
  "Return (:path :side :line :hunk) for the diff line at POS, or nil."
  (save-excursion
    (goto-char pos)
    (let ((section (magit-current-section)))
      (when (and (magit-hunk-section-p section)
                 (not (oref section combined))
                 (>= (line-beginning-position) (oref section content))
                 (not (fdbk--rendered-line-p)))
        (let ((target (line-beginning-position))
              (file (oref section parent))
              (old (car (oref section from-range)))
              (new (car (oref section to-range))))
          (goto-char (oref section content))
          (catch 'loc
            (while (< (point) (oref section end))
              (unless (fdbk--rendered-line-p)
                (let ((prefix (char-after)))
                  (when (= (point) target)
                    (throw 'loc
                           (pcase prefix
                             (?- (list :path (fdbk--file-path file "old") :side "old" :line old :hunk section))
                             (?\\ nil)
                             (_ (list :path (fdbk--file-path file "new") :side "new" :line new :hunk section)))))
                  (pcase prefix
                    (?+ (cl-incf new))
                    (?- (cl-incf old))
                    (?\\ nil)
                    (_ (cl-incf new) (cl-incf old)))))
              (forward-line 1))
            nil))))))

(defun fdbk--region-location (beg end)
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
          (when-let* ((loc (fdbk--location-at (point))))
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

(defun fdbk--find-in-hunk (hunk side line)
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
            (unless (fdbk--rendered-line-p)
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

(defun fdbk--file-sections ()
  "Return the file sections of the current Magit diff buffer."
  (seq-filter #'magit-file-section-p (oref magit-root-section children)))

(defun fdbk--find-position (path side line)
  "Return the position of the diff line for PATH, SIDE and LINE, or nil."
  (seq-some (lambda (file)
              (and (equal (fdbk--file-path file side) path)
                   (seq-some (lambda (hunk)
                               (and (magit-hunk-section-p hunk)
                                    (not (oref hunk combined))
                                    (fdbk--find-in-hunk hunk side line)))
                             (oref file children))))
            (fdbk--file-sections)))

(defun fdbk--diff-hunk-line (orig section goto-from)
  "Call ORIG with SECTION and GOTO-FROM, ignoring inserted review lines."
  (if (not (bound-and-true-p fdbk-mode))
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
              (unless (or (fdbk--rendered-line-p)
                          (eq (char-after) (if goto-from ?+ ?-)))
                (cl-incf offset))
              (forward-line 1))
            (+ (car (if goto-from from-range to-range)) offset)))))))

(defun fdbk--strip-before-apply (orig &rest args)
  "Remove review text before Magit reads a patch; call ORIG with ARGS.
Magit refreshes the buffer after applying, which renders the review again."
  (when (bound-and-true-p fdbk-mode)
    (fdbk--clear-rendered))
  (apply orig args))

(advice-add 'magit-diff-hunk-line :around #'fdbk--diff-hunk-line)
(advice-add 'magit-apply--section-content :around #'fdbk--strip-before-apply)
(advice-add 'magit-diff-hunk-region-patch :around #'fdbk--strip-before-apply)

;;; Rendering

(defun fdbk--clear-rendered ()
  "Delete all inserted review text and overlays."
  (mapc #'delete-overlay fdbk--overlays)
  (setq fdbk--overlays nil)
  (when magit-root-section
    (fdbk--prune-sections magit-root-section))
  (let ((inhibit-read-only t))
    (while-let ((beg (text-property-any (point-min) (point-max) 'fdbk-rendered t)))
      (delete-region beg (or (next-single-property-change beg 'fdbk-rendered)
                             (point-max))))))

(defun fdbk--prune-sections (section)
  "Remove fdbk sections from the children of SECTION, recursively."
  (oset section children (seq-remove #'fdbk--rendered-section-p (oref section children)))
  (mapc #'fdbk--prune-sections (oref section children)))

(defun fdbk--rendered-section-p (section)
  "Return non-nil if SECTION was inserted by fdbk."
  (and section (memq (eieio-object-class section) '(fdbk-thread-section fdbk-summary-section))))

(defun fdbk--apply-faces (&rest _)
  "Reapply review faces after Magit repaints hunks."
  (when (bound-and-true-p fdbk-mode)
    (let ((inhibit-read-only t))
      (let ((pos (point-min)))
        (while-let ((beg (text-property-not-all pos (point-max) 'fdbk-face nil)))
          (setq pos (or (next-single-property-change beg 'fdbk-face) (point-max)))
          (put-text-property beg pos 'face (get-text-property beg 'fdbk-face)))))))

(advice-add 'magit-section-paint :after #'fdbk--apply-faces)

(cl-defmethod magit-section-highlight ((_section fdbk-thread-section))
  "Keep review faces intact when point enters a thread."
  (fdbk--apply-faces))

(cl-defmethod magit-section-highlight ((_section fdbk-summary-section))
  "Keep review faces intact when point enters the summary."
  (fdbk--apply-faces))

(defun fdbk--line (text face &rest props)
  "Return TEXT as a full rendered line with FACE and PROPS."
  (apply #'propertize (concat text "\n") 'face face 'fdbk-face face props))

(defun fdbk--format-time (iso)
  "Format the ISO 8601 timestamp ISO for display."
  (if (and (stringp iso) (>= (length iso) 16))
      (replace-regexp-in-string "T" " " (substring iso 0 16))
    (or iso "")))

(defun fdbk--location-label (thread)
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

(defun fdbk--insert-thread (thread &optional label)
  "Insert THREAD as a section at point.  Prefix the heading with LABEL."
  (let* ((resolved (plist-get thread :resolved))
         (linked (plist-get fdbk--review :github))
         (text-face (if resolved 'fdbk-resolved 'fdbk-comment-text))
         (head-face (if resolved 'fdbk-resolved 'fdbk-comment-heading))
         (status (string-join
                  (delq nil (list (if resolved "resolved" "unresolved")
                                  (and (plist-get thread :outdated) "outdated")))
                  ", ")))
    (magit-insert-section (fdbk-thread-section (plist-get thread :id) resolved)
      (magit-insert-heading
        (fdbk--line (format "    %sThread %s · %s" (if label (concat label " · ") "")
                           (plist-get thread :id) status)
                   'fdbk-heading))
      (when (plist-get thread :outdated)
        (let ((lines (plist-get (plist-get thread :anchor) :lines)))
          (when lines
            (insert (fdbk--line "      Originally on:" text-face))
            (dolist (line lines)
              (insert (fdbk--line (concat "      │ " line) text-face))))))
      (dolist (comment (plist-get thread :comments))
        (let* ((author (plist-get comment :author))
               (agent (equal (plist-get author :kind) "agent"))
               (pending (and linked (not (plist-get comment :github)))))
          (insert (fdbk--line (concat "    " (plist-get author :name)
                                     (if agent " (agent)" "")
                                     " · " (fdbk--format-time (plist-get comment :createdAt))
                                     (if pending " · not on GitHub yet" ""))
                             head-face 'fdbk-comment (plist-get comment :id)))
          (dolist (line (split-string (plist-get comment :body) "\n"))
            (insert (fdbk--line (concat "      " line) text-face 'fdbk-comment (plist-get comment :id)))))))))

(defun fdbk--insert-after-line (pos thread)
  "Insert THREAD after the diff line at POS, inside that line's hunk."
  (let ((hunk (save-excursion (goto-char pos) (magit-current-section)))
        (inhibit-read-only t))
    (save-excursion
      (goto-char pos)
      (forward-line 1)
      (while (and (fdbk--rendered-line-p) (not (eobp)))
        (forward-line 1))
      (let ((beg (point)))
        (let ((magit-insert-section--parent hunk)
              (magit-insert-section--current hunk))
          (fdbk--insert-thread thread))
        (put-text-property beg (point) 'fdbk-rendered t)))))

(defun fdbk--insert-summary (threads)
  "Insert the review summary, listing THREADS that are not shown inline."
  (let* ((inhibit-read-only t)
         (all (fdbk--threads))
         (open (seq-count (lambda (thread) (not (plist-get thread :resolved))) all))
         (github (plist-get fdbk--review :github)))
    (save-excursion
      (goto-char (point-min))
      (let ((beg (point)))
        (let ((magit-insert-section--parent magit-root-section)
              (magit-insert-section--current magit-root-section))
          (magit-insert-section (fdbk-summary-section 'fdbk-summary)
            (magit-insert-heading
              (fdbk--line (format "Review %s: %s · %d open of %d thread(s) · revision %s"
                                 (plist-get fdbk--review :id) (plist-get fdbk--review :title)
                                 open (length all) (fdbk--latest-revision))
                         'fdbk-heading))
            (when github
              (insert (fdbk--line (concat "  " (plist-get github :url)) 'fdbk-comment-text)))
            (dolist (thread threads)
              (fdbk--insert-thread thread (fdbk--location-label thread)))
            (insert (fdbk--line "" 'default))))
        (put-text-property beg (point) 'fdbk-rendered t)))))

(defun fdbk--highlight (beg end thread)
  "Highlight diff lines from BEG to END that THREAD comments on."
  (let ((ov (make-overlay beg (save-excursion (goto-char end) (min (point-max) (1+ (line-end-position)))))))
    (overlay-put ov 'face 'fdbk-commented-line)
    (overlay-put ov 'fdbk-thread (plist-get thread :id))
    (push ov fdbk--overlays)))

(defun fdbk--inline-position (thread)
  "Return the buffer position of THREAD's last anchored line, or nil."
  (let ((pos (plist-get thread :position)))
    (and (not (plist-get thread :outdated))
         (equal (plist-get pos :revision) (fdbk--revision))
         (plist-get pos :line)
         (fdbk--find-position (plist-get pos :path) (plist-get pos :side) (plist-get pos :line)))))

(defun fdbk--draw (review)
  "Draw REVIEW into the current buffer."
  (setq fdbk--review review)
  (fdbk--clear-rendered)
  (let (elsewhere)
    (dolist (thread (fdbk--threads))
      (if-let* ((pos (fdbk--inline-position thread)))
          (let* ((p (plist-get thread :position))
                 (start (and (plist-get p :startLine)
                             (fdbk--find-position (plist-get p :path) (plist-get p :side)
                                                 (plist-get p :startLine)))))
            (unless (plist-get thread :resolved)
              (fdbk--highlight (or start pos) pos thread))
            (fdbk--insert-after-line pos thread))
        (push thread elsewhere)))
    (fdbk--insert-summary (nreverse elsewhere)))
  (setq magit-section-highlight-force-update t)
  (fdbk--apply-faces)
  (force-mode-line-update))

(defun fdbk--render (&optional refresh)
  "Fetch the review and draw it.
With REFRESH, the buffer's diff was just recomputed: re-resolve the
review's target so that its latest revision matches what is shown."
  (when (and fdbk-mode fdbk--review-id)
    (condition-case err
        (let ((review (fdbk--call (append (list "show") (unless refresh '("--no-refresh"))
                                         (fdbk--review-arg)))))
          (when refresh
            (setq fdbk--shown-revision
                  (plist-get (car (last (plist-get (plist-get review :target) :revisions))) :n)))
          (fdbk--draw review))
      (user-error (message "fdbk: %s" (error-message-string err))))))

;;; Finding things at point

(defun fdbk--thread-section-at-point ()
  "Return the thread section at point, or nil."
  (let ((section (magit-current-section)))
    (while (and section (not (object-of-class-p section 'fdbk-thread-section)))
      (setq section (oref section parent)))
    section))

(defun fdbk--thread-id-at-point ()
  "Return the id of the thread at point or anchored on this line, or nil."
  (or (when-let* ((section (fdbk--thread-section-at-point))) (oref section value))
      (seq-some (lambda (ov) (overlay-get ov 'fdbk-thread))
                (overlays-at (line-beginning-position)))))

(defun fdbk--read-thread ()
  "Return the thread id at point, or signal a user error."
  (or (fdbk--thread-id-at-point) (user-error "No review thread here")))

(defun fdbk--read-comment (&optional predicate)
  "Return the id of the comment at point, asking when it is ambiguous.
Only comments satisfying PREDICATE are offered."
  (or (get-text-property (point) 'fdbk-comment)
      (let* ((thread (fdbk--thread (fdbk--read-thread)))
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

(defun fdbk--comment (id)
  "Return the comment with ID."
  (seq-some (lambda (thread)
              (seq-find (lambda (c) (equal (plist-get c :id) id)) (plist-get thread :comments)))
            (fdbk--threads)))

;;; Composing comments

(defvar-local fdbk--edit-callback nil
  "Function called with the text of a confirmed comment.")

(defvar-local fdbk--edit-allow-empty nil
  "Non-nil if the text being written may be empty.")

(defvar-keymap fdbk-edit-mode-map
  :doc "Keymap for `fdbk-edit-mode'."
  "C-c C-c" #'fdbk-edit-confirm
  "C-c C-k" #'fdbk-edit-cancel)

(define-minor-mode fdbk-edit-mode
  "Minor mode for writing a review comment.
\\{fdbk-edit-mode-map}"
  :lighter " Review-Edit")

(defun fdbk--edit (title initial callback &optional allow-empty)
  "Pop up a buffer titled TITLE, prefilled with INITIAL.
Call CALLBACK with the text when the user confirms it.  Unless
ALLOW-EMPTY, refuse to confirm empty text."
  (let ((buffer (generate-new-buffer (format "*fdbk %s*" title))))
    (with-current-buffer buffer
      (cond ((fboundp 'gfm-mode) (gfm-mode))
            ((fboundp 'markdown-mode) (markdown-mode))
            (t (text-mode)))
      (when initial (insert initial))
      (fdbk-edit-mode 1)
      (setq fdbk--edit-callback callback
            fdbk--edit-allow-empty allow-empty)
      (setq header-line-format
            (substitute-command-keys
             (format "%s · \\[fdbk-edit-confirm] to confirm, \\[fdbk-edit-cancel] to cancel" title))))
    (pop-to-buffer buffer)))

(defun fdbk-edit-confirm ()
  "Confirm the comment being written."
  (interactive)
  (let ((callback fdbk--edit-callback)
        (text (string-trim (buffer-substring-no-properties (point-min) (point-max)))))
    (unless callback (user-error "Not in a fdbk edit buffer"))
    (when (and (string-empty-p text) (not fdbk--edit-allow-empty))
      (user-error "The comment is empty"))
    (quit-window t)
    (funcall callback text)))

(defun fdbk-edit-cancel ()
  "Discard the comment being written."
  (interactive)
  (quit-window t)
  (message "Comment discarded"))

(defun fdbk--mutate (args &optional input)
  "Run the review command ARGS with INPUT, then redraw the review buffer."
  (fdbk--call (append args (fdbk--review-arg)) input)
  (fdbk--render))

(defun fdbk--compose (title args &optional initial)
  "Write a comment titled TITLE and pass it to the review command ARGS.
INITIAL prefills the comment."
  (let ((buffer (current-buffer)))
    (fdbk--edit title initial
               (lambda (text)
                 (with-current-buffer buffer
                   (fdbk--mutate (append args '("--body-file" "-")) text))))))

;;; Commands

(defun fdbk-comment (beg end)
  "Comment on the diff line at point, or on the lines from BEG to END."
  (interactive (if (use-region-p)
                   (list (region-beginning) (region-end))
                 (list (line-beginning-position) (line-beginning-position))))
  (fdbk--assert)
  (let ((loc (fdbk--region-location beg end)))
    (deactivate-mark)
    (fdbk--compose
     (format "comment on %s:%s" (plist-get loc :path) (plist-get loc :line))
     (append (list "comment" "--path" (plist-get loc :path)
                   "--side" (plist-get loc :side)
                   "--line" (number-to-string (plist-get loc :line))
                   "--revision" (number-to-string (fdbk--revision)))
             (when-let* ((start (plist-get loc :start-line)))
               (list "--start-line" (number-to-string start)))))))

(defun fdbk-comment-file ()
  "Comment on the file at point as a whole."
  (interactive)
  (fdbk--assert)
  (let ((section (magit-current-section)))
    (while (and section (not (magit-file-section-p section)))
      (setq section (oref section parent)))
    (unless section (user-error "No file here"))
    (fdbk--compose (format "comment on %s" (oref section value))
                  (list "comment" "--path" (oref section value)
                        "--revision" (number-to-string (fdbk--revision))))))

(defun fdbk-comment-review ()
  "Add a comment on the review as a whole."
  (interactive)
  (fdbk--assert)
  (fdbk--compose "review comment" (list "comment")))

(defun fdbk-reply ()
  "Reply to the thread at point."
  (interactive)
  (fdbk--assert)
  (let ((thread (fdbk--read-thread)))
    (fdbk--compose "reply" (list "reply" thread))))

(defun fdbk-edit-comment ()
  "Edit the comment at point."
  (interactive)
  (fdbk--assert)
  (let ((id (fdbk--read-comment)))
    (fdbk--compose "edit comment" (list "edit" id) (plist-get (fdbk--comment id) :body))))

(defun fdbk-delete-comment ()
  "Delete the comment at point."
  (interactive)
  (fdbk--assert)
  (let ((id (fdbk--read-comment (lambda (c) (not (plist-get c :github))))))
    (when (yes-or-no-p "Delete this comment? ")
      (fdbk--mutate (list "delete" id)))))

(defun fdbk-toggle-resolved ()
  "Resolve the thread at point, or reopen it if it is resolved."
  (interactive)
  (fdbk--assert)
  (let* ((id (fdbk--read-thread))
         (resolved (plist-get (fdbk--thread id) :resolved)))
    (fdbk--mutate (list (if resolved "unresolve" "resolve") id))))

(defun fdbk-refresh ()
  "Refresh the diff and move threads onto the current code."
  (interactive)
  (fdbk--assert)
  (magit-refresh))

(defun fdbk-close-review ()
  "Close the review and detach it from this buffer."
  (interactive)
  (fdbk--assert)
  (fdbk--call (append '("close") (fdbk--review-arg)))
  (fdbk-mode -1)
  (message "Review closed"))

(defun fdbk-delete-review ()
  "Delete the review and everything in it."
  (interactive)
  (fdbk--assert)
  (when (yes-or-no-p (format "Delete review %s and all its comments? " fdbk--review-id))
    (fdbk--call (append '("rm") (fdbk--review-arg)))
    (fdbk-mode -1)
    (message "Review deleted")))

(defun fdbk--attach (review)
  "Show REVIEW in the current Magit diff buffer."
  (unless (derived-mode-p 'magit-diff-mode)
    (user-error "Reviews can only be shown in Magit diff buffers"))
  (setq fdbk--review-id (plist-get review :id)
        fdbk--attached-spec (fdbk--buffer-spec))
  (fdbk-mode 1)
  (fdbk--render t)
  (fdbk--watch-review)
  (message (substitute-command-keys
            "Reviewing %s; \\[fdbk-dispatch] for review commands")
           (plist-get review :title)))

;;;###autoload
(defun fdbk-start (&optional title)
  "Start or resume a review of the diff in the current Magit buffer.
With a prefix argument, ask for a TITLE."
  (interactive (list (and current-prefix-arg (read-string "Review title: "))))
  (unless (derived-mode-p 'magit-diff-mode)
    (user-error "Run this in a Magit diff or revision buffer"))
  (let ((review (fdbk--call (append '("start") (and title (list "--title" title))
                                   (cons "--" (fdbk--buffer-spec))))))
    (fdbk--attach review)))

(defun fdbk--open-review (review)
  "Show REVIEW's diff in a Magit buffer and attach the review to it."
  (let ((default-directory (file-name-as-directory
                            (plist-get (plist-get review :target) :worktree))))
    (with-current-buffer (fdbk--show-spec (plist-get (plist-get review :target) :spec))
      (fdbk--attach review)
      (current-buffer))))

;;;###autoload
(defun fdbk-open (&optional all)
  "Open an existing review of the current repository.
With a prefix argument ALL, include closed reviews."
  (interactive "P")
  (let* ((default-directory (magit-toplevel))
         (reviews (fdbk--call (append '("list") (and all '("--all"))))))
    (unless reviews (user-error "No reviews"))
    (let* ((choices (mapcar (lambda (r)
                              (cons (format "%s  %-6s %3d open  %s" (plist-get r :id) (plist-get r :status)
                                            (plist-get r :unresolved) (plist-get r :title))
                                    r))
                            reviews))
           (choice (cdr (assoc (completing-read "Review: " choices nil t) choices))))
      (when (equal (plist-get choice :status) "closed")
        (fdbk--call (list "reopen" "--review" (plist-get choice :id))))
      (fdbk--open-review (fdbk--call (list "show" "--no-refresh" "--review" (plist-get choice :id)))))))

;;; GitHub

(defun fdbk--default-pr ()
  "Return the pull request at point as a string, if Forge knows one."
  (when (and (featurep 'forge) (fboundp 'forge-current-pullreq))
    (when-let* ((pr (ignore-errors (funcall 'forge-current-pullreq))))
      (number-to-string (oref pr number)))))

;;;###autoload
(defun fdbk-github-review (pr)
  "Review the GitHub pull request PR (a number, owner/repo#N or URL)."
  (interactive (list (read-string "Pull request: " (fdbk--default-pr))))
  (let ((default-directory (or (magit-toplevel) (user-error "Not in a git repository"))))
    (message "Fetching pull request %s..." pr)
    (fdbk--call-async (list "github" "start" pr) #'fdbk--open-review)))

(defun fdbk-github-link (pr)
  "Link this review to the GitHub pull request PR."
  (interactive (list (read-string "Pull request: " (fdbk--default-pr))))
  (fdbk--assert)
  (fdbk--mutate (list "github" "link" pr)))

(defun fdbk--after-github (buffer message)
  "Return a callback that re-renders BUFFER and shows MESSAGE."
  (lambda (_result)
    (when (buffer-live-p buffer)
      (with-current-buffer buffer (fdbk--render)))
    (message "%s" message)))

(defun fdbk-github-pull ()
  "Import threads and comments from the linked pull request."
  (interactive)
  (fdbk--assert)
  (message "Pulling review comments from GitHub...")
  (fdbk--call-async (append '("github" "pull") (fdbk--review-arg))
                   (fdbk--after-github (current-buffer) "Pulled review comments from GitHub")))

(defun fdbk-github-push (event)
  "Send new comments, replies, edits and resolutions to GitHub.
EVENT is \"approve\", \"request-changes\" or \"comment\"."
  (interactive
   (list (pcase (read-char-choice "Submit as [a]pprove, [r]equest changes, [c]omment? " '(?a ?r ?c))
           (?a "approve") (?r "request-changes") (?c "comment"))))
  (fdbk--assert)
  (let ((buffer (current-buffer))
        (args (append (list "github" "push" "--event" event) (fdbk--review-arg))))
    (fdbk--edit (format "review summary (%s, optional)" event) nil
               (lambda (text)
                 (message "Pushing review to GitHub...")
                 (fdbk--call-async (append args (unless (string-empty-p text) (list "--body" text)))
                                  (fdbk--after-github buffer "Pushed review to GitHub")))
               t)))

;;; Transient

;;;###autoload (autoload 'fdbk-dispatch "fdbk" nil t)
(transient-define-prefix fdbk-dispatch ()
  "Review commands."
  [:description
   (lambda ()
     (if (and fdbk-mode fdbk--review)
         (format "Review %s: %s" fdbk--review-id (plist-get fdbk--review :title))
       "Review"))
   ["Comment"
    :if (lambda () fdbk-mode)
    ("c" "On line or region" fdbk-comment)
    ("f" "On file" fdbk-comment-file)
    ("C" "On whole review" fdbk-comment-review)
    ("r" "Reply to thread" fdbk-reply)
    ("e" "Edit comment" fdbk-edit-comment)
    ("k" "Delete comment" fdbk-delete-comment)
    ("x" "Resolve or reopen thread" fdbk-toggle-resolved)]
   ["Review"
    ("s" "Start or resume in this buffer" fdbk-start)
    ("o" "Open review..." fdbk-open)
    ("g" "Refresh" fdbk-refresh :if (lambda () fdbk-mode))
    ("Q" "Close review" fdbk-close-review :if (lambda () fdbk-mode))
    ("D" "Delete review" fdbk-delete-review :if (lambda () fdbk-mode))]
   ["GitHub"
    ("R" "Review pull request..." fdbk-github-review)
    ("L" "Link to pull request..." fdbk-github-link :if (lambda () fdbk-mode))
    ("p" "Pull comments" fdbk-github-pull :if (lambda () (plist-get fdbk--review :github)))
    ("P" "Push and submit..." fdbk-github-push :if (lambda () (plist-get fdbk--review :github)))]])

(provide 'fdbk)
;;; fdbk.el ends here
