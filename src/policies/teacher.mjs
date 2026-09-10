/**
 * Policy for teaching projects: student records, grades, rosters and family contact data.
 *
 * WHY THIS IS NOT IN THE CORE RULES: for a classroom tool, publishing `grades.xlsx` to a public URL
 * is unacceptable and deserves a hard block. For a general-purpose publishing router that judgment
 * would be wrong — many legitimate artifacts are called `results.csv` or `scores.json`. So these
 * rules live in a separate policy that a caller opts into, and the core stays neutral.
 *
 * Every rule here is `severity: 'data'`: it blocks only when the file can actually carry records
 * (see `DATA_EXTENSIONS` in ./generic.mjs), otherwise it is reported as a warning. The patterns
 * deliberately over-match, because a false positive costs a rename while a false negative leaks a
 * class list onto a public URL.
 */

export const NAME = 'teacher';

export const DESCRIPTION = 'Student records, grades, rosters and family contact data (opt-in policy).';

export const RULES = [
  { id: 'student-records', severity: 'data', pattern: /(^|[._-])(student|pupil|learner)s?([._-]|$)/i, reason: 'student record file' },
  { id: 'grades', severity: 'data', pattern: /(^|[._-])(grade|grades|grading|mark|marks|score|scores|result|results)([._-]|$)/i, reason: 'grades or assessment results' },
  { id: 'roster', severity: 'data', pattern: /(^|[._-])(roster|classlist|class[._-]?list|roll|rollcall|attendance|register)([._-]|$)/i, reason: 'class roster or attendance list' },
  { id: 'contacts', severity: 'data', pattern: /(^|[._-])(contact|contacts|email|emails|phone|phones|parent|parents|guardian|guardians)([._-]|$)/i, reason: 'student or family contact list' },
  { id: 'iep', severity: 'data', pattern: /(^|[._-])(iep|ieps|504|sen|sped|ehr|report[._-]?card)([._-]|$)/i, reason: 'individual education or report-card data' }
];
