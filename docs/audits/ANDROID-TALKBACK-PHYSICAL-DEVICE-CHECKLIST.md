# Android TalkBack and physical-device review checklist

**Target:** Isolated Naughty Family acceptance staging only  
**Staging portal:** https://naughtyfamily-staging.pages.dev  
**Do not use production credentials for this review.** Use a synthetic staging session when the review requires the Admin Panel.

This checklist is the human-device portion of the accessibility review. Automated Playwright keyboard navigation, accessibility semantics checks, axe scans, and Android viewport emulation are useful proxies, but they cannot establish that TalkBack announces the interface correctly on a real phone.

## Before testing

Record the Android version, device model, Chrome version, TalkBack version, display scaling, and date. Use a test account and staging data only. Do not paste a live Torn API key into a staging page or test report.

## TalkBack pass

1. Enable TalkBack using the device's accessibility shortcut or Android Accessibility settings.
2. Open the staging portal in Chrome and navigate by swipe, not by touching each control.
3. Confirm the portal heading, current account identity, workspace section, and each workspace card are announced in a sensible order. The Admin Panel card must only be present for the synthetic administrator.
4. Open the Faction Dashboard. Move through the five section controls and verify their names are spoken. In Faction Activity, select a member and inspect the drilldown. Confirm its heading, member identity, capture time, first-observed/estimated-join labels, change history and table/list content are announced without relying on color alone.
5. Open Account Settings and move through each setting. Verify both private-live sharing checkboxes announce their labels and checked state. Do not toggle consent during this review.
6. With the synthetic administrator only, open the Admin Panel. Verify the read-only state, all nine section names, selected section state, section headings, status/error text and table column context. In Members, move through the member selector and scrollable table. In Private Live, verify the privacy-boundary note is announced before the diagnostic table.
7. Check that errors/status changes are not conveyed by color alone and that the keyboard/screen-reader focus does not become trapped. Use Back and the portal navigation to leave each workspace.

## Physical layout and interaction pass

1. Test portrait at the normal font/display size, then increase Android font size and Chrome page zoom. Check 360–432 CSS-pixel widths where available.
2. Rotate to landscape. Confirm the page remains usable and no important content is cut off.
3. Activate every visible control with touch. Check that labels do not overlap, checkboxes are easy to hit, and horizontally scrollable tables can be intentionally scrolled without moving the whole page sideways.
4. Use Chrome's zoom controls or pinch zoom where enabled. Verify content reflows and controls remain reachable.
5. Repeat the keyboard-only sequence with an external keyboard if one is available: Tab to the Admin Panel card, Enter, move across section controls, and verify visible focus throughout.

## Record findings

For each issue, record the screen, exact control/announcement, expected result, actual result, and a screenshot or short screen recording with synthetic data only. Do not include account secrets or private Torn data.

**Exit criteria:** No focus trap; all actionable controls have meaningful spoken names/states; heading/landmark order is understandable; no essential information is available only by color; portrait/landscape and enlarged text remain usable; and scrollable data regions can be discovered and operated.
