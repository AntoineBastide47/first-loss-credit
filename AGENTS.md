# Working Rules

Follow these rules for all tasks unless the current user message gives a more specific instruction.

## Priorities

- Optimize for correctness, then performance, then developer experience, in that order.
- Treat readability as a tool for correctness and maintenance, not as an end by itself.
- Prefer simple designs that satisfy all three priorities.
- Spend design effort before implementation when it can prevent complexity or production cost.
- Do not accept known technical debt in changed code.
- Do not ship undefined behavior, unsound ownership or borrow rules, or avoidable exponential work.

## Communication

- Use concise ASD-STE100 Simplified Technical English.
- Use direct statements.
- Prefer short, common words when they are precise.
- Remove every word that does not add useful information.
- Prefer active voice.
- Avoid metaphors, idioms, figures of speech, and unnecessary jargon.
- Use technical terms when they are more precise than common words.
- Do not add unnecessary explanation.
- Do not mention yourself in Git commit messages.
- Do not suggest, create, or request smoke tests.

## Task Quality

- Complete the full requested task.
- Do not stop mid-task to report progress. Continue until the task is complete or blocked on input only the user can provide.
- Do not defer a sub-item silently. List anything not done, with the reason.
- Before reporting completion, verify every sub-item against the files, builds, and tests — not against your recollection.
- Surface every defect you find. Never leave a known defect unreported.
- When the user asks a question, answer it. Do not change code unless asked.
- Verify a checkable fact (git state, API signature, numbers, environment) before you state it.
- Check related code and behavior when needed to make the requested change correct.
- Fix root causes. Do not hide defects with workarounds. A symptom that recurs after your fix means the fix was wrong: trace to the origin.
- If a correct solution requires a large or unclear workaround because of a bug in a tool, compiler, or dependency that we control, stop and ask before you add the workaround.
- Do not overengineer.
- Prefer the smallest correct change.
- Minimize added code, complexity, maintenance cost, latency, allocations, and unnecessary work.
- Preserve existing behavior unless the task requires a behavior change.

## Code Changes

- Change only the files and code that are necessary for the task.
- Follow YAGNI principles, and prefer one-liner solutions.
- Prefer existing abstractions when they are suitable.
- Add an abstraction only when it makes the domain clearer or removes real duplication.
- Do not add abstractions for hypothetical future use.
- Do not add defensive code for conditions that cannot occur under the existing contract.
- Keep performance-sensitive paths efficient.
- Do not trade correctness or readability for meaningless code-size reduction.
- Remove dead code that becomes unnecessary because of the requested change when removal is safe and directly related to the task.

## Correctness

- Use simple, explicit control flow.
- Give every loop and queue a fixed upper bound.
- Assert the intended non-termination of loops that are designed to run forever.
- Handle every operating error.
- Treat assertion failures as programmer errors and corrupt state as fatal.
- Treat all compiler warnings at the strictest supported setting as errors.

## Performance

- Consider performance during design, not only after implementation.
- Estimate network, disk, memory, and CPU costs when they can affect the design.
- Consider both bandwidth and latency.
- Optimize the slowest or most frequently used resources first.
- Prefer flat data and predictable access over unnecessary pointer chasing.
- Amortize allocation cost.
- Grow dynamic containers geometrically instead of one element at a time.

## Dependencies

- Keep dependencies minimal.
- Treat every new dependency as a supply-chain, versioning, build, and maintenance cost.

## Git

- Never run `git commit` unless the current user message explicitly asks for a commit.
- Never run `git push` unless the current user message explicitly asks for a push.
- Run `git status` before any `checkout`, `restore`, `reset`, or `clean`. Never revert paths you did not create.
- After any git action, verify with `git status` or `git log` that it happened before reporting it.
- Permission to commit or push applies only to the current user message. It does not carry to later messages.
- If asked to commit, create exactly one commit unless the user asks for more.
- Never use `git commit --no-verify`, `git commit -n`, or any method that disables or skips hooks.
- If a Git hook fails, fix the cause. Do not bypass the hook.

### Commit Messages

- Use only a short subject line unless the user explicitly asks for a body.
- Do not use `--` punctuation or em dashes.
- Do not mention session-local identifiers such as phase numbers, bug numbers, or increment numbers unless they are real project identifiers required by the user.
- Do not mention tests, checks, benchmarks, or validation results.
- Do not mention the assistant or AI.
- Make the subject describe the change clearly enough to remain useful in `git blame`.

## Web Search

Use web search when the task needs current external facts, a referenced page or paper,
precise quotations, external recommendations, or information that is uncertain or
likely to change. Do not use web search for repository facts that source inspection can
answer.

For technical claims, use primary sources such as official documentation, standards,
source repositories, or research papers. Compare publication or update dates when
recency matters. Cite every web-derived claim with a direct Markdown link. State when
the conclusion is an inference.

Search may support design work for algorithms, implementations, performance data, and
similar systems. It does not replace local benchmarks, source review or tests.
Do not add external dependencies based only on a search
result; review license, maintenance, and supply-chain impact first.
