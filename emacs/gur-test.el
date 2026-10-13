;;; gur-test.el --- Tests for gur.el  -*- lexical-binding: t; -*-

;;; Commentary:

;; Runs real Magit diff buffers against a scratch repository, using the
;; CLI from source through bun.

;;; Code:

(require 'ert)
(require 'gur)

(defvar gur-test--cli
  (expand-file-name "../core/src/cli.ts"
                    (file-name-directory (or load-file-name buffer-file-name))))

(defun gur-test--git (&rest args)
  "Run git with ARGS in `default-directory', returning trimmed output."
  (with-temp-buffer
    (unless (eq 0 (apply #'call-process "git" nil t nil args))
      (error "git %S failed: %s" args (buffer-string)))
    (string-trim (buffer-string))))

(defun gur-test--write (file content)
  "Write CONTENT to FILE in `default-directory'."
  (with-temp-file (expand-file-name file) (insert content)))

(defun gur-test--lines (n)
  "Return N numbered lines."
  (mapconcat (lambda (i) (format "line %d\n" i)) (number-sequence 1 n) ""))

(defconst gur-test--scratch-prefix "gur-el-")

(defun gur-test--make-scratch-dir ()
  "Create and return a new scratch directory."
  (file-name-as-directory
   (file-truename (make-temp-file gur-test--scratch-prefix t))))

(defun gur-test--delete-scratch-dir (dir)
  "Kill DIR's buffers and delete DIR, but only if it is a scratch directory."
  (let ((tmp (file-name-as-directory (file-truename temporary-file-directory))))
    (unless (and (stringp dir)
                 (string-prefix-p tmp dir)
                 (equal (file-name-directory (directory-file-name dir)) tmp)
                 (string-prefix-p gur-test--scratch-prefix
                                  (file-name-nondirectory (directory-file-name dir))))
      (error "Refusing to delete non-scratch directory %S" dir))
    (dolist (buffer (buffer-list))
      (when (string-prefix-p dir (or (buffer-local-value 'default-directory buffer) ""))
        (with-current-buffer buffer (when gur-mode (gur-mode -1)))
        (kill-buffer buffer)))
    (delete-directory dir t)))

(defmacro gur-test--with-repo (&rest body)
  "Run BODY in a scratch repository with a modified a.txt."
  (declare (indent 0))
  (let ((dir (make-symbol "dir")))
  `(let* ((,dir (gur-test--make-scratch-dir))
          (default-directory ,dir)
          (gur-program (or (getenv "GUR_TEST_BUN") "bun"))
          (gur-program-args (list gur-test--cli))
          (magit-display-buffer-noselect t)
          (magit-display-buffer-function
           (lambda (buffer) (display-buffer buffer '(display-buffer-no-window (allow-no-window . t)))))
          (magit-save-repository-buffers nil))
     (unwind-protect
         (progn
           (gur-test--git "init" "-q" "-b" "main")
           (gur-test--git "config" "user.name" "Tester")
           (gur-test--git "config" "user.email" "t@example.com")
           (gur-test--write "a.txt" (gur-test--lines 30))
           (gur-test--git "add" ".")
           (gur-test--git "commit" "-qm" "init")
           (gur-test--write "a.txt" (replace-regexp-in-string
                                     "line 10\n" "line 10\nadded\n" (gur-test--lines 30)))
           ,@body)
       (gur-test--delete-scratch-dir ,dir)))))

(defun gur-test--diff-buffer (&optional range typearg)
  "Return a Magit diff buffer for RANGE and TYPEARG."
  (magit-diff-setup-buffer (or range "HEAD") typearg nil nil 'committed))

(defun gur-test--goto-line-text (text)
  "Move to the diff line whose content is TEXT."
  (goto-char (point-min))
  (re-search-forward (concat "^[-+ ]" (regexp-quote text) "$"))
  (beginning-of-line))

(defun gur-test--compose (command text)
  "Call COMMAND, type TEXT into its edit buffer and confirm.
Return to the review buffer afterwards, as a user would."
  (let ((review-buffer (current-buffer)))
    (funcall command)
    (insert text)
    (gur-edit-confirm)
    (set-buffer review-buffer)))

(defun gur-test--comment (text)
  "Comment TEXT on the line at point via the edit buffer."
  (gur-test--compose (lambda () (gur-comment (point) (point))) text))

(ert-deftest gur-test-buffer-spec ()
  (gur-test--with-repo
    (with-current-buffer (gur-test--diff-buffer)
      (should (equal (gur--buffer-spec) '("HEAD"))))
    (with-current-buffer (magit-diff-setup-buffer nil "--cached" nil '("a.txt") 'staged)
      (should (equal (gur--buffer-spec) '("--cached" "--" "a.txt"))))
    (with-current-buffer (magit-revision-setup-buffer "HEAD" nil nil)
      (should (equal (gur--buffer-spec) (list (concat (gur-test--git "rev-parse" "HEAD") "^!")))))))

(ert-deftest gur-test-comment-renders-inline ()
  (gur-test--with-repo
    (with-current-buffer (gur-test--diff-buffer)
      (gur-start)
      (should gur-mode)
      (gur-test--goto-line-text "added")
      (should (equal (gur--location-at (point)) (list :path "a.txt" :side "new" :line 11
                                                      :hunk (magit-current-section))))
      (gur-test--comment "Why add this?")
      (should (= 1 (length (gur--threads))))
      (gur-test--goto-line-text "added")
      (forward-line 1)
      (should (gur--rendered-line-p))
      (should (string-match-p "Thread [0-9a-f]+ · unresolved" (thing-at-point 'line)))
      (should (search-forward "Why add this?" nil t))
      (gur-test--goto-line-text "line 11")
      (should (equal (plist-get (gur--location-at (point)) :line) 12))
      (should (= 12 (magit-diff-hunk-line (magit-current-section) nil))))))

(ert-deftest gur-test-reply-resolve-and-region ()
  (gur-test--with-repo
    (with-current-buffer (gur-test--diff-buffer)
      (gur-start)
      (gur-test--goto-line-text "added")
      (gur-test--comment "first")
      (gur-test--goto-line-text "added")
      (forward-line 1)
      (gur-test--compose #'gur-reply "a reply")
      (let ((thread (car (gur--threads))))
        (should (equal (mapcar (lambda (c) (plist-get c :body)) (plist-get thread :comments))
                       '("first" "a reply"))))
      (gur-test--goto-line-text "added")
      (forward-line 1)
      (gur-toggle-resolved)
      (should (plist-get (car (gur--threads)) :resolved))
      (let ((beg (progn (gur-test--goto-line-text "line 9") (point)))
            (end (progn (gur-test--goto-line-text "line 11") (line-end-position))))
        (should (equal (gur--region-location beg end)
                       '(:path "a.txt" :side "new" :line 12 :start-line 9)))
        (should (equal (gur--region-location beg (progn (gur-test--goto-line-text "line 11") (point)))
                       '(:path "a.txt" :side "new" :line 11 :start-line 9)))))))

(ert-deftest gur-test-refresh-moves-threads ()
  (gur-test--with-repo
    (with-current-buffer (gur-test--diff-buffer)
      (gur-start)
      (gur-test--goto-line-text "added")
      (gur-test--comment "keep me")
      (gur-test--write "a.txt" (replace-regexp-in-string
                                "line 2\n" "line 2\nmore\n"
                                (replace-regexp-in-string "line 10\n" "line 10\nadded\n" (gur-test--lines 30))))
      (magit-refresh-buffer)
      (let ((pos (plist-get (car (gur--threads)) :position)))
        (should (equal (plist-get pos :line) 12))
        (should (equal (plist-get pos :revision) 2)))
      (gur-test--goto-line-text "added")
      (forward-line 1)
      (should (gur--rendered-line-p)))))

(ert-deftest gur-test-staging-ignores-review-text ()
  (gur-test--with-repo
    (with-current-buffer (magit-diff-setup-buffer nil nil nil nil 'unstaged)
      (gur-start)
      (gur-test--goto-line-text "added")
      (gur-test--comment "comment text")
      (gur-test--goto-line-text "added")
      (magit-stage)
      (should (equal (gur-test--git "diff" "--cached" "--numstat") "1\t0\ta.txt")))))

(ert-deftest gur-test-external-changes-rerender ()
  (gur-test--with-repo
    (with-current-buffer (gur-test--diff-buffer)
      (gur-start)
      (gur--call (list "comment" "--review" gur--review-id "--path" "a.txt" "--line" "11"
                       "--agent" "--author" "bot" "--body" "from an agent"))
      (gur--rerender-if-changed (current-buffer))
      (should (= 1 (length (gur--threads))))
      (goto-char (point-min))
      (should (search-forward "bot (agent)" nil t)))))

(provide 'gur-test)
;;; gur-test.el ends here
