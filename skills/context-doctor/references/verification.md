# Baselines and verification

Read this when applying changes, verifying existing edits or interpreting branch drift.

1. Capture a complete JSON snapshot with `context-doctor scan --inventory --all` before editing. Use the requested scope and store the output in a temporary or explicitly selected location outside the target checkout. A scan with findings exits 1 and still supplies the snapshot.
2. After an authorised correction, run the same complete command from the same checkout and scope. Pass both files to `context-doctor compare <before.json> <after.json>`. Comparison requires a full scan at both severities. Git changed-path reports are for triage and cannot be used as comparison inputs.
3. Use `cleared` for a uniquely matched check that was rerun successfully. An unverified disappearance can mean the document was removed, the reference was rewritten, a prerequisite became unavailable or repeated occurrences could not be paired. For a rewritten reference, independently confirm the replacement exists, the edited instruction points to it, and analysis coverage is sufficient. Verify any semantic change separately.
4. Inspect changed document statuses, counts and coverage before describing improvement. An introduced finding is newly reported in the comparison. Git history or other evidence is needed to establish whether the underlying problem is new.
5. Reread the modified instructions from the affected task. Check that the entry point still leads to the required procedure, known constraints survive, scope and authority are clear, and commands agree with trusted evidence. Compare the intended task outcome before interpreting size or repetition changes.

If an edit has already occurred and a compatible baseline is unavailable, use the current scan, actual diff and independently inspected prior content. State which parts can be verified directly and which changes in results are inferred. A Git merge base identifies a review scope and can help locate prior content. It supplies no old diagnostic result on its own.

Report the source and supporting evidence for each important finding, what changed, what the tool rechecked, what semantic judgment was made and any uncertainty that affects the decision. A good final report remains useful even when the scanner returns zero findings.
