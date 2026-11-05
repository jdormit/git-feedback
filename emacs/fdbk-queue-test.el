;;; fdbk-queue-test.el --- Tests for fdbk-queue.el  -*- lexical-binding: t; -*-

;;; Commentary:

;; Uses the helpers in fdbk-test.el, which must be loaded first.

;;; Code:

(require 'ert)
(require 'fdbk-queue)

(defun fdbk-test-queue--pr (number &rest props)
  "Return a pull request item NUMBER with PROPS overriding the defaults."
  (append props
          (list :kind "pull-request" :id (format "github.com/acme/app#%d" number)
                :version (format "head%d" number) :repo "acme/app" :dir "/tmp/" :number number
                :title (format "PR %d" number) :url (format "https://github.com/acme/app/pull/%d" number)
                :author "alice" :authorIsBot nil :createdAt "2026-11-01T00:00:00Z"
                :updatedAt "2026-11-04T00:00:00Z" :branch "b" :size '(:files 1 :additions 10 :deletions 2)
                :state "unreviewed" :requested nil :authorOnTeam nil :familiarFiles 0 :approvals 0)))

(defun fdbk-test-queue--agent (id &rest props)
  "Return an agent work item ID with PROPS overriding the defaults."
  (append props
          (list :kind "agent" :id id :version "v1" :repo "acme/app" :dir default-directory
                :branch "feature" :title (format "Agent %s" id) :updatedAt "2026-11-04T00:00:00Z"
                :state "unreviewed" :running nil :sessions nil :spec '("HEAD")
                :size '(:files 1 :additions 1 :deletions 0))))

(defmacro fdbk-test-queue--with-buffer (items &rest body)
  "Render ITEMS in a scratch queue buffer and run BODY there."
  (declare (indent 1))
  `(let ((fdbk-queue-dismissed-file (make-temp-file "fdbk-dismissed"))
         (fdbk-queue--dismissed nil)
         (fdbk-queue--data (list :generatedAt "2026-11-05T12:00:00Z" :items ,items :warnings nil)))
     (unwind-protect
         (with-temp-buffer
           (fdbk-queue-mode)
           (fdbk-queue--render)
           ,@body)
       (delete-file fdbk-queue-dismissed-file))))

(defun fdbk-test-queue--headings ()
  "Return the group headings in the current queue buffer."
  (mapcar (lambda (section)
            (string-trim (buffer-substring-no-properties
                          (oref section start)
                          (save-excursion (goto-char (oref section start)) (line-end-position)))))
          (oref magit-root-section children)))

(defun fdbk-test-queue--ids (group)
  "Return the item ids listed under GROUP."
  (let ((section (seq-find (lambda (s) (eq (oref s value) group))
                           (oref magit-root-section children))))
    (mapcar (lambda (child) (plist-get (oref child value) :id)) (oref section children))))

(ert-deftest fdbk-test-queue-groups-and-orders-items ()
  (fdbk-test-queue--with-buffer
      (list (fdbk-test-queue--pr 1)
            (fdbk-test-queue--pr 2 :requested "team")
            (fdbk-test-queue--pr 3 :requested "you")
            (fdbk-test-queue--pr 4 :state "changed-since-review")
            (fdbk-test-queue--pr 5 :authorOnTeam t :familiarFiles 3)
            (fdbk-test-queue--agent "w1")
            (fdbk-test-queue--agent "w2" :state "agent-replied"))
    (should (equal (fdbk-test-queue--headings)
                   '("Agent work (2)" "Re-review (1)" "Requested from you (1)" "Your team (2)" "Everything else (1)")))
    (should (equal (fdbk-test-queue--ids 'agent) '("w2" "w1")))
    (should (equal (fdbk-test-queue--ids 'team) '("github.com/acme/app#5" "github.com/acme/app#2")))))

(ert-deftest fdbk-test-queue-score-explains-itself ()
  (let ((familiar (fdbk-test-queue--pr 1 :familiarFiles 2 :approvals 1)))
    (should (equal (fdbk-queue--labels familiar) '("2 files you changed recently" "1 approval")))
    (should (> (fdbk-queue--score (fdbk-test-queue--pr 1 :familiarFiles 2))
               (fdbk-queue--score (fdbk-test-queue--pr 1))))
    (should (< (fdbk-queue--score (fdbk-test-queue--pr 1 :authorIsBot t))
               (fdbk-queue--score (fdbk-test-queue--pr 1))))))

(ert-deftest fdbk-test-queue-dismiss-until-changed ()
  (fdbk-test-queue--with-buffer (list (fdbk-test-queue--pr 1 :requested "you")
                                      (fdbk-test-queue--pr 2 :requested "you"))
    (goto-char (point-min))
    (search-forward "PR 1")
    (fdbk-queue-dismiss)
    (should (equal (plist-get (fdbk-queue--item-at-point) :id) "github.com/acme/app#2"))
    (should (equal (fdbk-test-queue--ids 'requested) '("github.com/acme/app#2")))
    (should (equal (fdbk-test-queue--ids 'dismissed) '("github.com/acme/app#1")))
    (should (equal (car (last (fdbk-test-queue--headings))) "Dismissed (1)"))
    (setq fdbk-queue--dismissed nil)
    (fdbk-queue--load-dismissed)
    (should (fdbk-queue--dismissed-p (fdbk-test-queue--pr 1)))
    (should-not (fdbk-queue--dismissed-p (fdbk-test-queue--pr 1 :version "new")))))

(ert-deftest fdbk-test-queue-forgets-dismissed-items-that-are-gone ()
  (fdbk-test-queue--with-buffer (list (fdbk-test-queue--pr 1))
    (setq fdbk-queue--dismissed '(("github.com/acme/app#1" . "head1") ("gone" . "v")))
    (fdbk-queue--receive (list :generatedAt "2026-11-05T12:00:00Z" :items (list (fdbk-test-queue--pr 1))))
    (should (equal fdbk-queue--dismissed '(("github.com/acme/app#1" . "head1"))))))

(defun fdbk-test-queue--refresh-error (program)
  "Refresh the queue with PROGRAM as the CLI and return the error shown."
  (let ((fdbk-program program)
        (fdbk-program-args nil)
        (fdbk-queue-repositories '("/tmp"))
        (fdbk-queue--refreshing nil)
        (fdbk-queue--error nil))
    (fdbk-queue-refresh)
    (with-timeout (10 (error "Refresh did not finish"))
      (while fdbk-queue--refreshing (accept-process-output nil 0.05)))
    fdbk-queue--error))

(ert-deftest fdbk-test-queue-refresh-reports-failures ()
  (should (string-match-p "exit status 1" (fdbk-test-queue--refresh-error "false")))
  (should (fdbk-test-queue--refresh-error "/nonexistent/fdbk"))
  (let ((fdbk-queue-repositories nil))
    (should-error (fdbk-queue-refresh) :type 'user-error)))

(ert-deftest fdbk-test-queue-review-agent-work ()
  (fdbk-test--with-repo
    (let ((item (fdbk-test-queue--agent "w1" :dir default-directory)))
      (fdbk-test-queue--with-buffer (list item)
        (goto-char (point-min))
        (search-forward "Agent w1")
        (let ((review-buffer (fdbk-queue-review)))
          (with-current-buffer review-buffer
            (should fdbk-mode)
            (should (equal (plist-get (fdbk--call (list "show" "--no-refresh" "--review" fdbk--review-id)) :title)
                           "Agent w1"))))))))

(provide 'fdbk-queue-test)
;;; fdbk-queue-test.el ends here
