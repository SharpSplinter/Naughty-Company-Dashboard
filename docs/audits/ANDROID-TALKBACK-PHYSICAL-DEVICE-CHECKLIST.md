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

## Physical Android review log (2026-11-13)

**Evidence source:** User-performed review on a physical Android phone against the isolated staging portal. Device model, Android/Chrome/TalkBack versions, and display scaling were not recorded in the conversation.

### TalkBack results reported

- The user personally reviewed the dashboard pages and tabs and reported that TalkBack correctly stated the purpose/function of the features, functions, and selections.
- On Faction Weekly Rankings, the `Rank by` control was announced as a “mini popup button” with an activation instruction. After activation, choices were announced with their selected state and radio-button role. The selected option was spoken as “Checked, Xanax, Radio Button”; other choices were announced as “Unchecked.”
- The user reported that the other controls and selections, including the Data status filter, announced their purpose and classification correctly.
- The user confirmed the dashboard’s TalkBack features were working properly overall.
- **Heading announcement follow-up:** In a targeted follow-up using TalkBack heading navigation, the user confirmed that the title was announced as “Faction Weekly Rankings Heading 1.” This verifies that the title is exposed to TalkBack as a level-one heading. The earlier observation that the word “heading” was not appended during ordinary swipe reading is not a defect; no markup change is indicated.

### Physical layout results reported

- Portrait mode with Android font size increased: passed; the user reported the layout continued to work properly.
- Landscape mode: passed; the user reported the view continued to work properly.

### Scope and limitations

- This is genuine user-reported physical-device evidence, not Playwright or Android viewport emulation.
- The Android model/version, browser/TalkBack versions, and display scaling were not recorded. The user later separately confirmed completing the external-keyboard navigation, pinch/page-zoom, and synthetic-admin-only Admin Panel reviews (see the 2026-11-14 follow-up below). Granular per-control observations and the behavior of every scrollable table were not separately described, so this log does not invent those details.
- No live Torn API credential was entered for this review. The staging portal remains the test target.


## Additional physical-device verification (2026-11-14)

**Evidence source:** The user explicitly confirmed personally verifying each of the following on the physical Android device against the staging portal:

- External-keyboard navigation.
- Pinch/page zoom.
- The synthetic-admin Admin Panel review.

These three review areas are recorded as user-confirmed complete. The conversation did not include granular results for every individual control or table, nor device/browser/TalkBack version details; no more specific outcome is inferred. This follow-up supplements the 2026-11-13 TalkBack, heading-navigation, enlarged-text portrait, and landscape findings above.

No production credentials or production resources were involved in this review.
