# Jasmine onboarding parity

The onboarding implementation reconstructs the observed `/onboarding/select-flow` screen. REA evidence is indexed in [reconstruction status](RECONSTRUCTION_STATUS.md). Original captures remain outside this repository because they contain account information and runtime/tracking code. Working screenshot filenames were reused during later authenticated captures; the original onboarding evidence JSON was retained separately.

## Evidence mapping

| Observed reference | Implementation |
| --- | --- |
| Fixed header with 24px symbol, 16px vertical and 24px desktop horizontal padding | `.site-header`, `.brand` |
| Centered 464px content region | `.onboarding` and full viewport `main` |
| 24px semibold heading, 32px line height, 64px gap before choices | `h1` |
| 224 × 128px choice cards, 16px gap, 8px corners | `.choice`, `.cards` |
| Code and briefcase icons, 24px | Inline SVGs matching captured icon geometry |
| Choice descriptions hidden below resting label; exposed on hover | `.choice-copy` transform and opacity; also exposed on keyboard focus |
| 32px Skip button positioned 8px above content | `.skip-row`, `.skip` |
| Demo row below cards with 16px gap | `.demo-wrap`, `.demo` |
| Below 640px: vertically stacked cards, relative Skip, fixed bottom demo row | Small-screen media query derived from captured responsive classes |
| From 1536px: larger typography, 256 × 160px cards, 24px gap | Large-screen media query derived from captured responsive classes |

## Deliberate local differences and limits

- Identity is Jasmine. The compact mark keeps the reference proportions with simplified geometry and an accessible Jasmine label.
- Start from scratch, Deploy a use case, and Skip open the local `/studio` route, retaining the observed onboarding intent query where applicable. They require that route to be provided by the local server.
- The guided demo opens an accessible local walkthrough instead of a remote appointment booking. The badge says “Local walkthrough” instead of promising cloud credits.
- Help opens local guidance and links to `/docs`, the local API documentation endpoint.
- No analytics, third-party requests, survey widgets, or cookie modal are included. The captured screenshot was dimmed by a third-party cookie overlay; the reconstructed underlying page uses a white background.
- Typography uses locally available Arial/Helvetica. The capture advertises Geist font resources, but these fonts are not bundled here; exact glyph-level parity is not claimed.
- Help contents and walkthrough contents are local adaptations. Authenticated flow-list and editor observations informed `workspace.html`, `workspace.css` and `workspace.js`. Their visual and interaction parity remains partial; the complete gap list is in the reconstruction status document.

The initial screen makes no network requests beyond its same-origin CSS and JavaScript. It writes no browser storage. Responsive dimensions are based on observed source classes. The running local editor passed a browser check covering save, deploy and test with deterministic mock responses and no page script errors.
