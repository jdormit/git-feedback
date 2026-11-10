;;; fdbk-test.el --- Tests for fdbk.el  -*- lexical-binding: t; -*-

;;; Commentary:

;; Runs real Magit diff buffers against a scratch repository, using the
;; CLI from source through bun.

;;; Code:

(require 'ert)
(require 'fdbk)

(defvar fdbk-test--cli
  (expand-file-name "../core/src/cli.ts"
                    (file-name-directory (or load-file-name buffer-file-name))))

(defun fdbk-test--git (&rest args)
  "Run git with ARGS in `default-directory', returning trimmed output."
  (with-temp-buffer
    (unless (eq 0 (apply #'call-process "git" nil t nil args))
      (error "git %S failed: %s" args (buffer-string)))
    (string-trim (buffer-string))))

(defun fdbk-test--write (file content)
  "Write CONTENT to FILE in `default-directory'."
  (with-temp-file (expand-file-name file) (insert content)))

(defun fdbk-test--lines (n)
  "Return N numbered lines."
  (mapconcat (lambda (i) (format "line %d\n" i)) (number-sequence 1 n) ""))

(defconst fdbk-test--scratch-prefix "fdbk-el-")

(defun fdbk-test--make-scratch-dir ()
  "Create and return a new scratch directory."
  (file-name-as-directory
   (file-truename (make-temp-file fdbk-test--scratch-prefix t))))

(defun fdbk-test--delete-scratch-dir (dir)
  "Kill DIR's buffers and delete DIR, but only if it is a scratch directory."
  (let ((tmp (file-name-as-directory (file-truename temporary-file-directory))))
    (unless (and (stringp dir)
                 (string-prefix-p tmp dir)
                 (equal (file-name-directory (directory-file-name dir)) tmp)
                 (string-prefix-p fdbk-test--scratch-prefix
                                  (file-name-nondirectory (directory-file-name dir))))
      (error "Refusing to delete non-scratch directory %S" dir))
    (dolist (buffer (buffer-list))
      (when (string-prefix-p dir (or (buffer-local-value 'default-directory buffer) ""))
        (with-current-buffer buffer (when fdbk-mode (fdbk-mode -1)))
        (kill-buffer buffer)))
    (delete-directory dir t)))

(defmacro fdbk-test--with-repo (&rest body)
  "Run BODY in a scratch repository with a modified a.txt."
  (declare (indent 0))
  (let ((dir (make-symbol "dir")))
  `(let* ((,dir (fdbk-test--make-scratch-dir))
          (default-directory ,dir)
          (fdbk-program (or (getenv "FDBK_TEST_BUN") "bun"))
          (fdbk-program-args (list fdbk-test--cli))
          (magit-display-buffer-noselect t)
          (magit-display-buffer-function
           (lambda (buffer) (display-buffer buffer '(display-buffer-no-window (allow-no-window . t)))))
          (magit-save-repository-buffers nil))
     (unwind-protect
         (progn
           (fdbk-test--git "init" "-q" "-b" "main")
           (fdbk-test--git "config" "user.name" "Tester")
           (fdbk-test--git "config" "user.email" "t@example.com")
           (fdbk-test--write "a.txt" (fdbk-test--lines 30))
           (fdbk-test--git "add" ".")
           (fdbk-test--git "commit" "-qm" "init")
           (fdbk-test--write "a.txt" (replace-regexp-in-string
                                      "line 10\n" "line 10\nadded\n" (fdbk-test--lines 30)))
           ,@body)
       (fdbk-test--delete-scratch-dir ,dir)))))

(defun fdbk-test--diff-buffer (&optional range typearg)
  "Return a Magit diff buffer for RANGE and TYPEARG."
  (magit-diff-setup-buffer (or range "HEAD") typearg nil nil 'committed))

(defun fdbk-test--goto-line-text (text)
  "Move to the diff line whose content is TEXT."
  (goto-char (point-min))
  (re-search-forward (concat "^[-+ ]" (regexp-quote text) "$"))
  (beginning-of-line))

(defun fdbk-test--compose (command text)
  "Call COMMAND, type TEXT into its edit buffer and confirm.
Return to the review buffer afterwards, as a user would."
  (let ((review-buffer (current-buffer)))
    (funcall command)
    (insert text)
    (fdbk-edit-confirm)
    (set-buffer review-buffer)))

(defun fdbk-test--comment (text)
  "Comment TEXT on the line at point via the edit buffer."
  (fdbk-test--compose (lambda () (fdbk-comment (point) (point))) text))

(ert-deftest fdbk-test-buffer-spec ()
  (fdbk-test--with-repo
    (with-current-buffer (fdbk-test--diff-buffer)
      (should (equal (fdbk--buffer-spec) '("HEAD"))))
    (with-current-buffer (magit-diff-setup-buffer nil "--cached" nil '("a.txt") 'staged)
      (should (equal (fdbk--buffer-spec) '("--cached" "--" "a.txt"))))
    (with-current-buffer (magit-revision-setup-buffer "HEAD" nil nil)
      (should (equal (fdbk--buffer-spec) (list (concat (fdbk-test--git "rev-parse" "HEAD") "^!")))))))

(ert-deftest fdbk-test-comment-renders-inline ()
  (fdbk-test--with-repo
    (with-current-buffer (fdbk-test--diff-buffer)
      (fdbk-start)
      (should fdbk-mode)
      (fdbk-test--goto-line-text "added")
      (should (equal (fdbk--location-at (point)) (list :path "a.txt" :side "new" :line 11
                                                       :hunk (magit-current-section))))
      (fdbk-test--comment "Why add this?")
      (should (= 1 (length (fdbk--threads))))
      (fdbk-test--goto-line-text "added")
      (forward-line 1)
      (should (fdbk--rendered-line-p))
      (should (string-match-p "Thread [0-9a-f]+ · unresolved" (thing-at-point 'line)))
      (should (search-forward "Why add this?" nil t))
      (fdbk-test--goto-line-text "line 11")
      (should (equal (plist-get (fdbk--location-at (point)) :line) 12))
      (should (= 12 (magit-diff-hunk-line (magit-current-section) nil))))))

(ert-deftest fdbk-test-comments-are-human-inside-agent-shells ()
  (fdbk-test--with-repo
    (let ((process-environment (cons "OPENCODE=1" process-environment)))
      (with-current-buffer (fdbk-test--diff-buffer)
        (fdbk-start)
        (fdbk-test--goto-line-text "added")
        (fdbk-test--comment "mine")
        (should (equal (plist-get (car (plist-get (car (fdbk--threads)) :comments)) :author)
                       '(:name "Tester" :kind "human")))))))

(ert-deftest fdbk-test-reply-resolve-and-region ()
  (fdbk-test--with-repo
    (with-current-buffer (fdbk-test--diff-buffer)
      (fdbk-start)
      (fdbk-test--goto-line-text "added")
      (fdbk-test--comment "first")
      (fdbk-test--goto-line-text "added")
      (forward-line 1)
      (fdbk-test--compose #'fdbk-reply "a reply")
      (let ((thread (car (fdbk--threads))))
        (should (equal (mapcar (lambda (c) (plist-get c :body)) (plist-get thread :comments))
                       '("first" "a reply"))))
      (fdbk-test--goto-line-text "added")
      (forward-line 1)
      (fdbk-toggle-resolved)
      (should (plist-get (car (fdbk--threads)) :resolved))
      (let ((beg (progn (fdbk-test--goto-line-text "line 9") (point)))
            (end (progn (fdbk-test--goto-line-text "line 11") (line-end-position))))
        (should (equal (fdbk--region-location beg end)
                       '(:path "a.txt" :side "new" :line 12 :start-line 9)))
        (should (equal (fdbk--region-location beg (progn (fdbk-test--goto-line-text "line 11") (point)))
                       '(:path "a.txt" :side "new" :line 11 :start-line 9)))))))

(ert-deftest fdbk-test-refresh-moves-threads ()
  (fdbk-test--with-repo
    (with-current-buffer (fdbk-test--diff-buffer)
      (fdbk-start)
      (fdbk-test--goto-line-text "added")
      (fdbk-test--comment "keep me")
      (fdbk-test--write "a.txt" (replace-regexp-in-string
                                 "line 2\n" "line 2\nmore\n"
                                 (replace-regexp-in-string "line 10\n" "line 10\nadded\n" (fdbk-test--lines 30))))
      (magit-refresh-buffer)
      (let ((pos (plist-get (car (fdbk--threads)) :position)))
        (should (equal (plist-get pos :line) 12))
        (should (equal (plist-get pos :revision) 2)))
      (fdbk-test--goto-line-text "added")
      (forward-line 1)
      (should (fdbk--rendered-line-p)))))

(ert-deftest fdbk-test-staging-ignores-review-text ()
  (fdbk-test--with-repo
    (with-current-buffer (magit-diff-setup-buffer nil nil nil nil 'unstaged)
      (fdbk-start)
      (fdbk-test--goto-line-text "added")
      (fdbk-test--comment "comment text")
      (fdbk-test--goto-line-text "added")
      (magit-stage)
      (should (equal (fdbk-test--git "diff" "--cached" "--numstat") "1\t0\ta.txt")))))

(ert-deftest fdbk-test-external-changes-rerender ()
  (fdbk-test--with-repo
    (with-current-buffer (fdbk-test--diff-buffer)
      (fdbk-start)
      (fdbk--call (list "comment" "--review" fdbk--review-id "--path" "a.txt" "--line" "11"
                       "--agent" "--author" "bot" "--body" "from an agent"))
      (fdbk--rerender-if-changed (current-buffer))
      (should (= 1 (length (fdbk--threads))))
      (goto-char (point-min))
      (should (search-forward "bot (agent)" nil t)))))

(ert-deftest fdbk-test-external-refresh-redraws-diff ()
  (fdbk-test--with-repo
    (with-current-buffer (fdbk-test--diff-buffer)
      (fdbk-start)
      (fdbk-test--goto-line-text "added")
      (fdbk-test--comment "keep me")
      (fdbk-test--write "a.txt" (replace-regexp-in-string
                                 "line 2\n" "line 2\nmore\n"
                                 (replace-regexp-in-string "line 10\n" "line 10\nadded\n" (fdbk-test--lines 30))))
      (fdbk--call (list "refresh" "--review" fdbk--review-id))
      (fdbk--rerender-if-changed (current-buffer))
      (should (equal fdbk--shown-revision 2))
      (fdbk-test--goto-line-text "added")
      (should (equal (plist-get (fdbk--location-at (point)) :line) 12))
      (forward-line 1)
      (should (fdbk--rendered-line-p))
      (fdbk-test--goto-line-text "line 11")
      (fdbk-test--comment "second")
      (let ((thread (car (last (fdbk--threads)))))
        (should (equal (plist-get (plist-get thread :position) :line) 13))
        (should-not (plist-get thread :outdated))))))

(ert-deftest fdbk-test-open-cli-review-survives-refresh ()
  (fdbk-test--with-repo
    (fdbk-test--git "add" "a.txt")
    (let* ((review (fdbk--call '("start" "--" "--staged")))
           (buffer (fdbk--open-review review)))
      (with-current-buffer buffer
        (should fdbk-mode)
        (magit-refresh-buffer)
        (should fdbk-mode)
        (should (equal fdbk--review-id (plist-get review :id)))))))

(ert-deftest fdbk-test-kill-buffer-removes-watch ()
  (fdbk-test--with-repo
    (let (watch)
      (with-current-buffer (fdbk-test--diff-buffer)
        (fdbk-start)
        (setq watch fdbk--watch)
        (should watch)
        (kill-buffer))
      (should-not (file-notify-valid-p watch)))))

(defmacro fdbk-test--with-threads (&rest body)
  "Run BODY in a review buffer with four threads, binding `ids' by body.
In buffer order: a review comment, \"first\" and \"resolved\" in one
hunk, and \"later\" in another hunk.  \"resolved\" is resolved."
  (declare (indent 0))
  `(fdbk-test--with-repo
     (fdbk-test--write "a.txt" (replace-regexp-in-string
                                "line 20\n" "line 20\nsecond\n"
                                (replace-regexp-in-string "line 10\n" "line 10\nadded\n"
                                                          (fdbk-test--lines 30))))
     (with-current-buffer (fdbk-test--diff-buffer)
       (fdbk-start)
       (fdbk-test--goto-line-text "added")
       (fdbk-test--comment "first")
       (fdbk-test--goto-line-text "line 12")
       (fdbk-test--comment "resolved")
       (fdbk-test--goto-line-text "second")
       (fdbk-test--comment "later\nmore detail")
       (fdbk--mutate '("comment" "--body" "about the review"))
       (let ((ids (mapcar (lambda (thread)
                            (cons (car (split-string (plist-get (car (plist-get thread :comments)) :body) "\n"))
                                  (plist-get thread :id)))
                          (fdbk--threads))))
         (fdbk--mutate (list "resolve" (alist-get "resolved" ids nil nil #'equal)))
         ,@body))))

(defun fdbk-test--thread-at-point (ids)
  "Return the first comment of the thread at point, looked up in IDS."
  (car (rassoc (oref (fdbk--thread-section-at-point) value) ids)))

(ert-deftest fdbk-test-next-thread-skips-resolved-and-wraps ()
  (fdbk-test--with-threads
    (goto-char (point-min))
    (should (equal (cl-loop repeat 4
                            collect (progn (fdbk-next-thread)
                                           (should (= (point) (oref (fdbk--thread-section-at-point) start)))
                                           (fdbk-test--thread-at-point ids)))
                   '("about the review" "first" "later" "about the review")))
    (should (equal (cl-loop repeat 3
                            collect (progn (fdbk-previous-thread) (fdbk-test--thread-at-point ids)))
                   '("later" "first" "about the review")))))

(ert-deftest fdbk-test-next-thread-with-prefix-includes-resolved ()
  (fdbk-test--with-threads
    (fdbk-test--goto-line-text "added")
    (fdbk-next-thread '(4))
    (should (equal (fdbk-test--thread-at-point ids) "first"))
    (fdbk-next-thread '(4))
    (should (equal (fdbk-test--thread-at-point ids) "resolved"))
    (fdbk-previous-thread)
    (should (equal (fdbk-test--thread-at-point ids) "first"))
    (forward-line 1)
    (fdbk-previous-thread)
    (should (= (point) (oref (fdbk--thread-section-at-point) start)))
    (should (equal (fdbk-test--thread-at-point ids) "first"))))

(ert-deftest fdbk-test-next-thread-expands-collapsed-sections ()
  (fdbk-test--with-threads
    (fdbk-test--goto-line-text "second")
    (let ((hunk (magit-current-section)))
      (magit-section-hide hunk)
      (fdbk-test--goto-line-text "line 12")
      (fdbk-next-thread)
      (should (equal (fdbk-test--thread-at-point ids) "later"))
      (should-not (oref hunk hidden))
      (should-not (invisible-p (point))))))

(ert-deftest fdbk-test-imenu-lists-threads ()
  (fdbk-test--with-threads
    (let ((index (funcall imenu-create-index-function)))
      (should (equal (mapcar #'car (alist-get "Threads" index nil nil #'equal))
                     '("review — about the review"
                       "a.txt:11 (new) — first"
                       "a.txt:13 (new) — resolved [resolved]"
                       "a.txt:22 (new) — later")))
      (should (assoc "modified   a.txt" index)))
    (fdbk-mode -1)
    (should-not (assoc "Threads" (funcall imenu-create-index-function)))
    (should-not (local-variable-p 'imenu-auto-rescan))))

(defun fdbk-test--goto-rendered (regexp)
  "Move to the start of the rendered line matching REGEXP."
  (goto-char (point-min))
  (while (progn (re-search-forward regexp)
                (not (fdbk--rendered-line-p))))
  (beginning-of-line))

(defun fdbk-test--has-face (face pos)
  "Return non-nil if the text at POS is drawn with FACE."
  (memq face (ensure-list (get-text-property pos 'font-lock-face))))

(defun fdbk-test--rule-after-line (pos)
  "Return non-nil if a rule is drawn after the line ending at POS."
  (seq-some (lambda (ov) (overlay-get ov 'fdbk-rule))
            (overlays-in pos (1+ pos))))

(defun fdbk-test--fringe-p ()
  "Return non-nil if the line at point has a fringe bar."
  (seq-some (lambda (ov) (overlay-get ov 'fdbk-fringe))
            (overlays-in (line-beginning-position) (line-beginning-position))))

(ert-deftest fdbk-test-thread-lines-have-status-bar ()
  (fdbk-test--with-threads
    (pcase-dolist (`(,body . ,bar) '(("first" . fdbk-thread-bar)
                                     ("resolved" . fdbk-thread-bar-resolved)))
      (fdbk-test--goto-rendered (concat "^ +" body "$"))
      (let ((marker (+ (point) 2)))
        (should (equal (get-text-property marker 'display) '(space :width 0.3)))
        (should (memq bar (flatten-tree (get-text-property marker 'font-lock-face)))))
      (should (get-text-property (point) 'wrap-prefix)))))

(ert-deftest fdbk-test-faces-survive-refontification ()
  (fdbk-test--with-threads
    ;; What `font-lock-mode' does, which batch Emacs won't turn on.
    (setq-local char-property-alias-alist '((face font-lock-face)))
    (let ((inhibit-read-only t))
      (font-lock-default-unfontify-region (point-min) (point-max)))
    (fdbk-test--goto-rendered "^ +first$")
    (should (memq 'fdbk-thread-bar (flatten-tree (get-char-property (+ (point) 2) 'face))))
    (should (memq 'fdbk-comment-text (ensure-list (get-char-property (line-end-position) 'face))))))

(ert-deftest fdbk-test-bar-shows-through-hl-line ()
  (fdbk-test--with-threads
    (fdbk-test--goto-rendered "^ +first$")
    (hl-line-mode 1)
    (hl-line-highlight)
    (let ((marker (+ (point) 2)))
      (should (memq 'fdbk-thread-bar (flatten-tree (get-char-property marker 'face)))))))

(ert-deftest fdbk-test-commented-lines-get-a-fringe-bar ()
  (fdbk-test--with-threads
    (fdbk-test--goto-line-text "added")
    (should (fdbk-test--fringe-p))
    (fdbk-test--goto-line-text "line 9")
    (should-not (fdbk-test--fringe-p))
    (fdbk-test--goto-line-text "line 12")
    (should-not (fdbk-test--fringe-p))))

(ert-deftest fdbk-test-fringe-bars-skip-threads-inside-a-range ()
  (fdbk-test--with-repo
    (with-current-buffer (fdbk-test--diff-buffer)
      (fdbk-start)
      (fdbk-test--goto-line-text "added")
      (fdbk-test--comment "inner")
      (let ((beg (progn (fdbk-test--goto-line-text "line 9") (point)))
            (end (progn (fdbk-test--goto-line-text "line 11") (line-end-position))))
        (fdbk-test--compose (lambda () (fdbk-comment beg end)) "outer"))
      (dolist (text '("line 9" "line 10" "added" "line 11"))
        (fdbk-test--goto-line-text text)
        (should (fdbk-test--fringe-p)))
      (goto-char (point-min))
      (while (not (eobp))
        (when (fdbk--rendered-line-p)
          (should-not (fdbk-test--fringe-p)))
        (forward-line 1)))))

(ert-deftest fdbk-test-thread-heading-badges ()
  (fdbk-test--with-threads
    (fdbk-test--goto-rendered "Thread [0-9a-f]+ · \\(unresolved\\)")
    (should (fdbk-test--has-face 'fdbk-status-unresolved (match-beginning 1)))
    (fdbk-test--goto-rendered "Thread [0-9a-f]+ · \\(resolved\\)")
    (should (fdbk-test--has-face 'fdbk-status-resolved (match-beginning 1)))))

(ert-deftest fdbk-test-threads-are-delimited-by-rules ()
  (fdbk-test--with-threads
    (fdbk-test--goto-line-text "added")
    (should (fdbk-test--rule-after-line (line-end-position)))
    (fdbk-test--goto-rendered "^ +first$")
    (let ((section (fdbk--thread-section-at-point)))
      (should (fdbk-test--rule-after-line (1- (oref section end)))))))

(ert-deftest fdbk-test-long-comment-lines-wrap ()
  (fdbk-test--with-repo
    (with-current-buffer (fdbk-test--diff-buffer)
      (let ((fdbk-fill-column 20)
            (code "(a very long line of code that must stay intact)"))
        (fdbk-start)
        (fdbk-test--goto-line-text "added")
        (fdbk-test--comment (concat "one two three four five six seven eight\n"
                                    "- a list item that is long enough to wrap\n"
                                    "```\n" code "\n```"))
        (fdbk-test--goto-rendered "^ +one two three")
        (should (string-match-p "^ +one two three four$" (thing-at-point 'line)))
        (fdbk-test--goto-rendered "^ +- a list item")
        (forward-line 1)
        (should (string-match-p "^ +  is long enough to$" (thing-at-point 'line)))
        (fdbk-test--goto-rendered (regexp-quote code))
        (should (string-match-p (concat (regexp-quote code) "$") (thing-at-point 'line)))))))

(ert-deftest fdbk-test-blend ()
  (should (equal (fdbk--blend "#ffffff" "#000000" 0.25) "#3f3f3f"))
  (should-not (fdbk--blend "unspecified-fg" "#000000" 0.25))
  (should-not (fdbk--blend nil "#000000" 0.25)))

(defun fdbk-test--overlays ()
  "Return the overlays fdbk drew in the current buffer."
  (seq-filter (lambda (ov) (overlay-get ov 'fdbk)) (overlays-in (point-min) (point-max))))

(ert-deftest fdbk-test-theme-change-redraws ()
  (fdbk-test--with-threads
    (let ((before (fdbk-test--overlays)))
      (run-hook-with-args 'enable-theme-functions 'user)
      (should (fdbk-test--overlays))
      (should-not (seq-intersection before (fdbk-test--overlays))))))

(ert-deftest fdbk-test-reopening-the-buffer-does-not-leak-overlays ()
  (fdbk-test--with-threads
    (let ((count (length (fdbk-test--overlays))))
      (should (> count 0))
      (fdbk-test--diff-buffer)
      (should-not (fdbk-test--overlays))
      (fdbk-start)
      (should (= count (length (fdbk-test--overlays)))))))

(ert-deftest fdbk-test-dispatch-key-wins-over-evil-bindings ()
  (skip-unless (require 'evil nil t))
  (unwind-protect
      (fdbk-test--with-repo
        (with-current-buffer (fdbk-test--diff-buffer)
          ;; What evil-collection does to Magit's keymaps.
          (evil-make-overriding-map magit-diff-mode-map 'all)
          (evil-local-mode 1)
          (fdbk-start)
          (fdbk-test--goto-line-text "added")
          (dolist (state '(normal visual motion insert emacs))
            (evil-change-state state)
            (should (eq (key-binding (kbd "C-c C-r")) #'fdbk-dispatch)))))
    (define-key magit-diff-mode-map [override-state] nil t)))

(provide 'fdbk-test)
;;; fdbk-test.el ends here
