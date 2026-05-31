export const insightInstruction = `
## Verification requirement

Before reporting anything, VERIFY your suspicion. Your initial read covered a limited scope, and a design that looks wrong locally is very often correct in broader context. Read more of the repository to confirm or refute:
- Read callers, callees, tests, configs, and adjacent modules of the suspect code.
- Check whether an apparent "missing check" / "unhandled case" / "bug" is already guaranteed elsewhere — by an upstream invariant, the caller, validation, the type system, or framework behavior.
- Keep a finding ONLY if it survives this wider investigation. If the broader context resolves it, drop it silently.

## What to report

Only genuinely high-value findings — the kind you would actually open an issue or PR for:
- Real bugs / correctness hazards: wrong logic, edge cases that genuinely occur, races, resource leaks, error paths that truly mishandle failure.
- Security issues with a real, reachable exploit path.
- Performance problems that actually bite at realistic input sizes.
- Concretely better implementations: a simpler, safer, or more correct approach with a clear tangible benefit (not a matter of taste).

## What NOT to report

- Style, naming, formatting, or personal preference.
- "Could add tests / docs / comments" without a specific, important gap.
- Defensive checks for inputs that cannot actually occur given how the code is called.
- Theoretical concerns you could not confirm against the wider codebase.
- Anything reported just to have something to say.

## Output field guide

Finding nothing is a perfectly good outcome for sound code: set hasFindings=false and leave insights empty. Do NOT pad to look diligent.

When you do have genuine findings (hasFindings=true), populate each item precisely:
- **title**: One-line summary of the issue.
- **severity**: \`critical\` = crash, data loss, or exploitable vulnerability; \`high\` = wrong behavior in common code paths; \`medium\` = edge-case risk under specific conditions; \`low\` = suboptimal but functional.
- **category**: \`correctness\` | \`security\` | \`performance\` | \`maintainability\` | \`reliability\` | \`other\`.
- **locations**: Array of code references in format \`"path/to/file.ext:START-END"\` (line range) or \`"path/to/file.ext:LINE"\` (single line). Must point to real code you have read. At least one location per finding.
- **problem**: What is wrong and the concrete real-world impact. Be specific — name the scenario, input, or condition that triggers it.
- **plan**: Actionable fix approach. Describe HOW to fix, not just "fix it."
- **confidence**: \`high\` = verified against callers and tests, reproducible; \`medium\` = likely correct but not fully verified or only under specific conditions; \`low\` = suspicious pattern with limited evidence.

Do not invent files, functions, or behaviors. Do NOT modify any code or documentation — output findings only.
`.trim();
