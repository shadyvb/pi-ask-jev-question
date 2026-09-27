/**
 * Ask User Question (Jev-scored) Tool
 *
 * Unified tool for asking single or multiple questions, where each question's
 * options are pre-scored by the Jev decision model (TypeSafe, via the
 * OpenRouter Decisions API). The recommended option is surfaced to the user
 * with a probability bar + confidence; selection stays entirely free.
 *
 * If Jev is unavailable (no API key, network failure, timeout, bad response),
 * the questionnaire degrades gracefully to the plain (unscored) UI.
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const JEV_MODEL = "typesafe/jev-1.13";

const CONFIG = {
	jev: { model: JEV_MODEL, timeoutMs: 10_000 },
	// Future: auto-answer low-risk questions without asking the user.
	// Flip enabled:true once recommendations prove reliable.
	autoAnswer: { enabled: false, minProbability: 0.9, minConfidence: 0.85 },
};

const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

// Jev scoring types
interface JevQuestionScore {
	id: string;
	recommended?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
	userAgreed?: boolean;
}

type JevScoring =
	| { ok: true; perQuestion: JevQuestionScore[] }
	| { ok: false; reason: string; perQuestion: [] };

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
	jev: JevScoring;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(
		Type.String({ description: "Unique identifier for this question (defaults to q1, q2, ...)" }),
	),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, {
		minItems: 2,
		maxItems: 255,
		description: "Available options to choose from",
	}),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	context: Type.String({
		minLength: 20,
		description:
			"Relevant context for Jev to evaluate the questions: current task, constraints, relevant file paths/snippets, and why you need an answer.",
	}),
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 10,
		description: "Questions to ask the user",
	}),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true, jev: { ok: false, reason: "not scored", perQuestion: [] } },
	};
}

// Jev helpers

/** 10-char probability bar: ▊ filled, ░ empty. */
function probBar(p: number): string {
	const filled = Math.max(0, Math.min(10, Math.round(p * 10)));
	return "▊".repeat(filled) + "░".repeat(10 - filled);
}

function shortReason(err: unknown): string {
	if (err instanceof Error && err.name === "AbortError") return "timeout";
	const msg = err instanceof Error ? err.message : String(err);
	return msg.length > 60 ? `${msg.slice(0, 57)}...` : msg;
}

function isProbRecord(v: unknown): v is Record<string, number> {
	if (typeof v !== "object" || v === null) return false;
	return Object.values(v).every((x) => typeof x === "number" && Number.isFinite(x));
}

interface JevChoiceAnswer {
	type?: string;
	choice?: string;
	probabilities?: unknown;
	confidence?: unknown;
}

interface JevResponse {
	answers?: Record<string, JevChoiceAnswer>;
}

/**
 * Score all questions with Jev in a single Decisions API request.
 * NEVER throws: any failure (missing key, network, non-200, timeout, parse
 * error, schema mismatch) degrades to { ok: false, reason }.
 */
async function scoreWithJev(context: string, questions: Question[]): Promise<JevScoring> {
	const fail = (reason: string): JevScoring => ({ ok: false, reason, perQuestion: [] });

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) return fail("no api key");

	// One request for all questions. NOTE: the question key ("q0") is not seen
	// by Jev — all meaning must live in `instructions` and `criteria`.
	// (Verified live 2026-09: per-question objects live under a top-level
	// `questions` record; `state` is a separate required field.)
	const questionDefs: Record<string, unknown> = {};
	questions.forEach((q, i) => {
		questionDefs[`q${i}`] = {
			type: "choice",
			instructions: `Given the context, what is the best answer to: ${q.prompt}? Pick the option value that fits best.`,
			criteria: Object.fromEntries(q.options.map((o) => [o.value, o.description || o.label])),
		};
	});
	const body: Record<string, unknown> = {
		model: CONFIG.jev.model,
		state: {
			context,
			task_questions: questions.map((q) => ({
				prompt: q.prompt,
				options: q.options.map((o) => ({
					value: o.value,
					label: o.label,
					...(o.description !== undefined ? { description: o.description } : {}),
				})),
			})),
		},
		questions: questionDefs,
	};

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CONFIG.jev.timeoutMs);
	try {
		const res = await fetch(JEV_DECISIONS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) return fail(`http ${res.status}`);

		let data: JevResponse;
		try {
			data = (await res.json()) as JevResponse;
		} catch (err) {
			return fail(`parse error: ${shortReason(err)}`);
		}
		if (typeof data !== "object" || data === null || typeof data.answers !== "object" || data.answers === null) {
			return fail("bad response schema");
		}

		const perQuestion: JevQuestionScore[] = [];
		questions.forEach((q, i) => {
			const ans = data.answers?.[`q${i}`];
			if (!ans || ans.type !== "choice") return; // per-question guard: skip silently
			const probabilities = isProbRecord(ans.probabilities) ? ans.probabilities : undefined;
			let recommended: string | undefined;
			if (probabilities) {
				// Recommended = highest probability option
				recommended = Object.entries(probabilities).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
			} else if (typeof ans.choice === "string") {
				recommended = ans.choice;
			}
			perQuestion.push({
				id: q.id,
				...(recommended !== undefined ? { recommended } : {}),
				...(probabilities ? { probabilities } : {}),
				...(typeof ans.confidence === "number" && Number.isFinite(ans.confidence)
					? { confidence: ans.confidence }
					: {}),
			});
		});
		if (perQuestion.length === 0) return fail("no valid answers");
		return { ok: true, perQuestion };
	} catch (err) {
		return fail(shortReason(err));
	} finally {
		clearTimeout(timer);
	}
}

// AUTO-ANSWER SEAM
// Single choke point for auto-answering low-risk questions without asking the
// user. Disabled for now (returns null). When enabled, questions whose Jev
// score clears both thresholds come back as pre-filled answers; they are
// excluded from the UI and merged into the final result.
function maybeAutoAnswer(questions: Question[], jev: JevScoring): Map<string, Answer> | null {
	if (!CONFIG.autoAnswer.enabled || !jev.ok) return null;
	const auto = new Map<string, Answer>();
	for (const score of jev.perQuestion) {
		if (score.recommended === undefined) continue;
		const p = score.probabilities?.[score.recommended];
		if (p === undefined || p < CONFIG.autoAnswer.minProbability) continue;
		if (score.confidence === undefined || score.confidence < CONFIG.autoAnswer.minConfidence) continue;
		const q = questions.find((qq) => qq.id === score.id);
		const opt = q?.options.find((o) => o.value === score.recommended);
		if (!q || !opt) continue;
		auto.set(q.id, {
			id: q.id,
			value: opt.value,
			label: opt.label,
			wasCustom: false,
			index: q.options.indexOf(opt) + 1,
		});
	}
	return auto;
}

/** Attach userAgreed to each per-question score once answers are known. */
function finalizeJev(jev: JevScoring, answers: Answer[]): JevScoring {
	if (!jev.ok) return jev;
	return {
		ok: true,
		perQuestion: jev.perQuestion.map((score) => {
			const answer = answers.find((a) => a.id === score.id);
			if (!answer || score.recommended === undefined) return score;
			return { ...score, userAgreed: answer.value === score.recommended };
		}),
	};
}

function jevSummaryLine(jev: JevScoring): string {
	return jev.ok ? `Jev: ok ${jev.perQuestion.length} scored` : `Jev: unavailable: ${jev.reason}`;
}

export default function askJevQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User (Jev-scored)",
		description:
			"Ask the user one or more questions with options. Requires a context string which is sent to the Jev decision model; each question shows the user a Jev-recommended option with probability + confidence. Use when you need a human decision.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				id: q.id || `q${i + 1}`,
				label: q.label || `Q${i + 1}`,
				prompt: q.prompt,
				options: q.options,
				allowOther: q.allowOther !== false,
			}));

			const badQuestion = questions.find((q) => q.options.length < 2);
			if (badQuestion) {
				return errorResult(`Error: Question "${badQuestion.label}" has fewer than 2 options`, questions);
			}

			// Jev scoring (graceful: never throws, may come back ok:false)
			const jev = await scoreWithJev(params.context, questions);

			// AUTO-ANSWER SEAM
			const autoAnswers = maybeAutoAnswer(questions, jev);
			const uiQuestions = autoAnswers ? questions.filter((q) => !autoAnswers.has(q.id)) : questions;

			const isMulti = uiQuestions.length > 1;
			const totalTabs = uiQuestions.length + 1; // questions + Submit

			let result: QuestionnaireResult;
			if (uiQuestions.length === 0) {
				// Everything auto-answered — skip the UI entirely.
				const answers = Array.from(autoAnswers!.values());
				result = { questions, answers, cancelled: false, jev: finalizeJev(jev, answers) };
			} else {
				result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
					// State
					let currentTab = 0;
					let optionIndex = 0;
					let inputMode = false;
					let inputQuestionId: string | null = null;
					let cachedLines: string[] | undefined;
					const answers = new Map<string, Answer>(autoAnswers ?? []);

					// Editor for "Type something" option
					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					// Helpers
					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function submit(cancelled: boolean) {
						done({
							questions,
							answers: Array.from(answers.values()),
							cancelled,
							jev: finalizeJev(jev, Array.from(answers.values())),
						});
					}

					function currentQuestion(): Question | undefined {
						return uiQuestions[currentTab];
					}

					function currentJevScore(): JevQuestionScore | undefined {
						const q = currentQuestion();
						if (!q || !jev.ok) return undefined;
						return jev.perQuestion.find((s) => s.id === q.id);
					}

					function currentOptions(): RenderOption[] {
						const q = currentQuestion();
						if (!q) return [];
						const opts: RenderOption[] = [...q.options];
						// Recommended option (highest Jev probability) renders first
						const rec = currentJevScore()?.recommended;
						if (rec !== undefined) {
							const idx = opts.findIndex((o) => o.value === rec);
							if (idx > 0) {
								const [recOpt] = opts.splice(idx, 1);
								opts.unshift(recOpt);
							}
						}
						if (q.allowOther) {
							opts.push({ value: "__other__", label: "Type something.", isOther: true });
						}
						return opts;
					}

					function allAnswered(): boolean {
						return uiQuestions.every((q) => answers.has(q.id));
					}

					function advanceAfterAnswer() {
						if (!isMulti) {
							submit(false);
							return;
						}
						if (currentTab < uiQuestions.length - 1) {
							currentTab++;
						} else {
							currentTab = uiQuestions.length; // Submit tab
						}
						optionIndex = 0;
						refresh();
					}

					function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
						answers.set(questionId, { id: questionId, value, label, wasCustom, index });
					}

					// Editor submit callback
					editor.onSubmit = (value) => {
						if (!inputQuestionId) return;
						const trimmed = value.trim() || "(no response)";
						saveAnswer(inputQuestionId, trimmed, trimmed, true);
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
						advanceAfterAnswer();
					};

					function handleInput(data: string) {
						// Input mode: route to editor
						if (inputMode) {
							if (matchesKey(data, Key.escape)) {
								inputMode = false;
								inputQuestionId = null;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						const q = currentQuestion();
						const opts = currentOptions();

						// Tab navigation (multi-question only)
						if (isMulti) {
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
								currentTab = (currentTab + 1) % totalTabs;
								optionIndex = 0;
								refresh();
								return;
							}
							if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
								currentTab = (currentTab - 1 + totalTabs) % totalTabs;
								optionIndex = 0;
								refresh();
								return;
							}
						}

						// Submit tab
						if (currentTab === uiQuestions.length) {
							if (matchesKey(data, Key.enter) && allAnswered()) {
								submit(false);
							} else if (matchesKey(data, Key.escape)) {
								submit(true);
							}
							return;
						}

						// Option navigation
						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(opts.length - 1, optionIndex + 1);
							refresh();
							return;
						}

						// Select option
						if (matchesKey(data, Key.enter) && q) {
							const opt = opts[optionIndex];
							if (opt.isOther) {
								inputMode = true;
								inputQuestionId = q.id;
								editor.setText("");
								refresh();
								return;
							}
							saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
							advanceAfterAnswer();
							return;
						}

						// Cancel
						if (matchesKey(data, Key.escape)) {
							submit(true);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const renderWidth = Math.max(1, width);
						const q = currentQuestion();
						const opts = currentOptions();
						const score = currentJevScore();

						function addWrapped(text: string) {
							lines.push(...wrapTextWithAnsi(text, renderWidth));
						}

						function addWrappedWithPrefix(prefix: string, text: string) {
							const prefixWidth = visibleWidth(prefix);
							if (prefixWidth >= renderWidth) {
								addWrapped(prefix + text);
								return;
							}
							const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
							const continuationPrefix = " ".repeat(prefixWidth);
							for (let i = 0; i < wrapped.length; i++) {
								lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
							}
						}

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						// Tab bar (multi-question only)
						if (isMulti) {
							const tabs: string[] = ["← "];
							for (let i = 0; i < uiQuestions.length; i++) {
								const isActive = i === currentTab;
								const isAnswered = answers.has(uiQuestions[i].id);
								const lbl = uiQuestions[i].label;
								const box = isAnswered ? "■" : "□";
								const color = isAnswered ? "success" : "muted";
								const text = ` ${box} ${lbl} `;
								const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
								tabs.push(`${styled} `);
							}
							const canSubmit = allAnswered();
							const isSubmitTab = currentTab === uiQuestions.length;
							const submitText = " ✓ Submit ";
							const submitStyled = isSubmitTab
								? theme.bg("selectedBg", theme.fg("text", submitText))
								: theme.fg(canSubmit ? "success" : "dim", submitText);
							tabs.push(`${submitStyled} →`);
							addWrappedWithPrefix(" ", tabs.join(""));
							lines.push("");
						}

						// Helper to render options list
						function renderOptions() {
							for (let i = 0; i < opts.length; i++) {
								const opt = opts[i];
								const selected = i === optionIndex;
								const isOther = opt.isOther === true;
								const isRec = !isOther && score?.recommended !== undefined && opt.value === score.recommended;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								const recMark = isRec ? "▸★ " : "";
								const label = `${recMark}${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
								const color = selected || (isOther && inputMode) ? "accent" : "text";

								let row = theme.fg(color, label);
								if (score && !isOther) {
									const p = score.probabilities?.[opt.value];
									if (isRec) {
										const conf =
											score.confidence !== undefined ? ` conf=${score.confidence.toFixed(2)}` : "";
										const pStr = p !== undefined ? `p=${p.toFixed(2)}` : "p=?";
										row += theme.fg("success", ` ${pStr}${conf} ${p !== undefined ? probBar(p) : ""}`.trimEnd());
									} else if (p !== undefined) {
										row += theme.fg("dim", `  p=${p.toFixed(2)} ${probBar(p)}`);
									}
								}
								addWrappedWithPrefix(prefix, row);
								if (opt.description) {
									addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
								}
							}
						}

						// Content
						if (inputMode && q) {
							addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
							lines.push("");
							// Show options for reference
							renderOptions();
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
						} else if (currentTab === uiQuestions.length) {
							addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
							lines.push("");
							for (const question of questions) {
								const answer = answers.get(question.id);
								if (answer) {
									const prefix = answer.wasCustom ? "(wrote) " : "";
									const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
									addWrappedWithPrefix(" ", summary);
								}
							}
							lines.push("");
							if (allAnswered()) {
								addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
							} else {
								const missing = uiQuestions
									.filter((qq) => !answers.has(qq.id))
									.map((qq) => qq.label)
									.join(", ");
								addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
							}
						} else if (q) {
							addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
							lines.push("");
							renderOptions();
						}

						lines.push("");
						if (!inputMode) {
							// Jev footer on the first tab
							if (currentTab === 0) {
								const jevFooter = jev.ok
									? `Jev: ${CONFIG.jev.model} · scored ${jev.perQuestion.length} question${jev.perQuestion.length !== 1 ? "s" : ""}`
									: `Jev: unavailable (${jev.reason})`;
								addWrappedWithPrefix(" ", theme.fg("dim", jevFooter));
							}
							const help = isMulti
								? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
								: "↑↓ navigate • Enter select • Esc cancel";
							addWrappedWithPrefix(" ", theme.fg("dim", help));
						}
						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				});
			}

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: `User cancelled the questionnaire\n${jevSummaryLine(result.jev)}` }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const q = questions.find((qq) => qq.id === a.id);
				const qLabel = q?.label || a.id;
				let line = `Q "${qLabel}": ${a.label} (${a.value})`;
				if (result.jev.ok) {
					const score = result.jev.perQuestion.find((s) => s.id === a.id);
					if (score && score.recommended !== undefined) {
						const recLabel = q?.options.find((o) => o.value === score.recommended)?.label ?? score.recommended;
						const p = score.probabilities?.[score.recommended];
						line += ` [jev: ${recLabel} p=${p !== undefined ? p.toFixed(2) : "?"} conf=${score.confidence !== undefined ? score.confidence.toFixed(2) : "?"} ${score.userAgreed ? "AGREED" : "user overrode"}]`;
					}
				}
				return line;
			});
			answerLines.push(jevSummaryLine(result.jev));

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				const note = details.jev.ok
					? ` · jev scored ${details.jev.perQuestion.length}`
					: ` · jev unavailable (${details.jev.reason})`;
				return new Text(theme.fg("warning", "Cancelled") + theme.fg("dim", note), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
				if (details.jev.ok) {
					const score = details.jev.perQuestion.find((s) => s.id === a.id);
					if (score && score.recommended !== undefined) {
						const p = score.probabilities?.[score.recommended];
						const mark = score.userAgreed ? "★" : "≠";
						line += theme.fg("dim", ` [jev ${mark}${p !== undefined ? ` p=${p.toFixed(2)}` : ""}]`);
					}
				}
				return line;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
