Consolidate the pending memory proposals into the project memory tree.

Memory library (absolute path): {{MEMORY_DIR}}

Current tree index (top.json nodes):
{{TREE_INDEX}}

Pending proposals:
{{STAGING_LIST}}

Process every proposal listed above following your consolidation protocol: read each one, promote it to the right tree node (reusing existing nodes where reasonable, registering new nodes in top.json when not), merge duplicates into existing pages, `rm` each consumed proposal, and mark unfit ones with a `rejected: <reason>` frontmatter line instead of promoting them. Apply tree-health fixes only where the affected nodes are already in front of you — this is a consolidation pass, not a full audit.

End with exactly one line starting with `SUMMARY:`.
