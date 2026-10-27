const db = require('../db');

/**
 * Recalculates mcq/written/essay scores + totals for one submission from its
 * exam_answers + exam_paper_questions rows. Call this after correcting an
 * answer key, granting full marks, or excluding a question from scoring —
 * so the submission's stored totals stay consistent with what actually
 * happened, instead of drifting out of sync.
 */
function recomputeExamSubmission(submissionId) {
  const rows = db.prepare(
    `SELECT a.marks_awarded, q.type, q.marks, q.excluded_from_scoring
     FROM exam_answers a
     JOIN exam_paper_questions q ON q.id = a.question_id
     WHERE a.submission_id = ?`
  ).all(submissionId);

  let mcqScore = 0, mcqTotal = 0, writtenScore = 0, writtenTotal = 0, essayScore = 0, essayTotal = 0;

  rows.forEach((r) => {
    if (r.excluded_from_scoring) return; // doesn't count toward score OR total
    const awarded = r.marks_awarded || 0;
    if (r.type === 'mcq') { mcqScore += awarded; mcqTotal += r.marks; }
    else if (r.type === 'written') { writtenScore += awarded; writtenTotal += r.marks; }
    else { essayScore += awarded; essayTotal += r.marks; }
  });

  const totalScore = mcqScore + writtenScore + essayScore;
  const totalMarks = mcqTotal + writtenTotal + essayTotal;

  db.prepare(
    `UPDATE exam_submissions SET mcq_score=?, mcq_total=?, written_score=?, written_total=?,
     essay_score=?, essay_total=?, total_score=?, total_marks=? WHERE id = ?`
  ).run(mcqScore, mcqTotal, writtenScore, writtenTotal, essayScore, essayTotal, totalScore, totalMarks, submissionId);
}

module.exports = { recomputeExamSubmission };
