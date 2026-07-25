// CSV export for transcripts: packages the selected lessons as a ZIP that
// unzips into a folder of CSVs — one CSV per transcript (message rows) plus a
// _summary.csv with one metadata row per exported lesson.

import JSZip from "jszip";
import {
  parseTranscript,
  speakingRatio,
  estimateLessonDurationMs,
  formatDuration,
} from "./lessonMetrics";

// Structural subsets of the AllTranscripts row/user shapes — anything with
// these fields can be exported.
export interface ExportTranscriptRow {
  id: number;
  created_at: string;
  user_id: string;
  lesson_id: number;
  conversation_transcript: unknown;
  user_improvement_feedback: string | null;
  user_rating_feedback: number | null;
  ended_early: boolean | null;
  payment_status: string;
  word_timeline: unknown;
  exit_phase: string | null;
  exit_trigger: string | null;
}

export interface ExportUserMeta {
  preferred_name: string | null;
  native_language: string | null;
  learning_language: string | null;
  level: string | null;
  payment_status: string | null;
}

// RFC 4180 escaping: quote when the value contains a comma, quote, or newline.
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Excel needs the UTF-8 BOM to detect encoding — transcripts are routinely in
// Thai/Chinese/Japanese and open as mojibake without it. CRLF per RFC 4180.
function toCsv(rows: unknown[][]): string {
  const BOM = String.fromCharCode(0xfeff);
  return BOM + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function transcriptFileName(row: ExportTranscriptRow): string {
  return `transcript_${row.id}_lesson${row.lesson_id}_${row.user_id.slice(0, 8)}.csv`;
}

function transcriptCsv(row: ExportTranscriptRow): string {
  const messages = parseTranscript(row.conversation_transcript);
  return toCsv([
    ["message_index", "role", "text"],
    ...messages.map((m, i) => [i + 1, m.role, m.text]),
  ]);
}

function summaryCsv(
  rows: ExportTranscriptRow[],
  userMeta: ReadonlyMap<string, ExportUserMeta>,
): string {
  const header = [
    "file",
    "row_id",
    "created_at",
    "user_id",
    "preferred_name",
    "lesson_id",
    "rating",
    "ended_early",
    "exit_phase",
    "exit_trigger",
    "lesson_payment_status",
    "user_payment_status",
    "native_language",
    "learning_language",
    "level",
    "message_count",
    "duration_estimate",
    "duration_ms",
    "student_chars",
    "teacher_chars",
    "student_share",
    "improvement_feedback",
  ];
  const body = rows.map((row) => {
    const user = userMeta.get(row.user_id);
    const messages = parseTranscript(row.conversation_transcript);
    const { studentChars, teacherChars, studentShare } = speakingRatio(messages);
    const durationMs = estimateLessonDurationMs(row.word_timeline);
    return [
      transcriptFileName(row),
      row.id,
      row.created_at,
      row.user_id,
      user?.preferred_name ?? "",
      row.lesson_id,
      row.user_rating_feedback ?? "",
      row.ended_early ?? "",
      row.exit_phase ?? "",
      row.exit_trigger ?? "",
      row.payment_status ?? "",
      user?.payment_status ?? "",
      user?.native_language ?? "",
      user?.learning_language ?? "",
      user?.level ?? "",
      messages.length,
      durationMs === null ? "" : formatDuration(durationMs),
      durationMs ?? "",
      studentChars,
      teacherChars,
      studentShare === null ? "" : studentShare.toFixed(3),
      row.user_improvement_feedback ?? "",
    ];
  });
  return toCsv([header, ...body]);
}

// Decompose first so accented latin letters keep their base character
// ("Ana Sofía" -> ana-sofia, not ana-sof-a). Names in a non-latin script
// (Thai/Chinese/…) reduce to nothing, and callers fall back to the plain
// export name.
function slugify(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

// Build the ZIP and trigger a browser download. Resolves once the download has
// been handed to the browser. `label` tags the folder/zip name — pass it when
// exporting a single user's transcripts so several exports don't land in
// Downloads as export.zip, export (1).zip, …
export async function exportTranscriptsZip(
  rows: ExportTranscriptRow[],
  userMeta: ReadonlyMap<string, ExportUserMeta>,
  label?: string,
): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = label ? slugify(label) : "";
  const folderName = slug
    ? `transcripts-${slug}-${stamp}`
    : `transcripts-export-${stamp}`;

  const zip = new JSZip();
  const folder = zip.folder(folderName)!;
  folder.file("_summary.csv", summaryCsv(rows, userMeta));
  for (const row of rows) {
    folder.file(transcriptFileName(row), transcriptCsv(row));
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${folderName}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
