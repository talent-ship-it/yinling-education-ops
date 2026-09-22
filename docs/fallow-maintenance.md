# Fallow maintenance

Run the pinned analyzer and committed no-regression baselines after installing
the lockfile dependencies:

```sh
npm ci --ignore-scripts
npm run check:fallow
```

The project pins Fallow 3.26.0 in `devDependencies`; CI never downloads an
unreviewed latest version. The dead-code, health, and duplication baselines in
`fallow-baselines/` quarantine the existing backlog while failing on new
findings. Regenerate a baseline only in a dedicated review that explains the
accepted delta.

The config declares dynamically discovered Node tests and the shell-launched
WeCom receiver as entry points. It does not suppress unused exports or exclude
operational scripts. Verify shell commands, documentation and file-reading tests
before removing an unused-file candidate. The missing static Excel route in
`jiaowubao-static-excel-uploader-removal.test.mjs` is an intentional absence test.

The first optimization pass removes two unreferenced production packages and
the unused LP-service re-export that formed an import cycle. Audit filtering,
global tab counts and export/page selection now share a pure, tested view builder
that scans entries once instead of filtering repeatedly. The UI and export
permission boundary remain in the workspace.

Fallow full-scan candidates changed from 435 (test-entry calibrated audit) to
423, including unused dependencies 2 → 0 and cycles 1 → 0. The file candidate
reduction 13 → 12 comes from recognizing the shell-launched receiver, not deletion.
No legacy modules were deleted. Complexity and duplicate groups still need
incremental work; this change does not claim to resolve the entire report.

Next stages: extract cohesive workspace views and state; separate import
validation/matching/planning under behavior tests; consolidate duplication only
where business semantics match. Snapshot collection code with different proof
requirements should not be merged solely because its syntax looks alike.
