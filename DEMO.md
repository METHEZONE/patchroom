# Patchroom: 2-minute demo script

**Setup (before recording, about 2 minutes)**

```bash
cd ~/Projects/patchroom && npm start          # → http://localhost:4317
```

- Use two browser windows side by side, both dark:
  - **Left (Min, customer engineer):** `http://localhost:4317/?as=Min`
  - **Right (Junho, PayCo DevRel):** opens later from the room URL with `?as=Junho`
- Open a third tab with `https://github.com/METHEZONE/patchroom-demo-shop/pulls`. Close any old Patchroom PRs first.
- Record the screen with QuickTime (⌘⇧5 → *Record Entire Screen*), or use the backup recording below.
- The run takes about 70 seconds: about 45 s of agent work, plus about 20 s of CI after approval. Keep the narration moving.

> **Backup:** `docs/demo-side-by-side.mp4` is a real two-browser run (Playwright, about 80 s, no audio), made with `npm run demo`. If the live run misbehaves, voice over this file instead.

---

## Script (target 1:55)

| time | on screen / click | say (English) |
|---|---|---|
| **0:00–0:15** | Lobby (left window). Point at the PayCo card's red→green rows. | "When Stripe or any API ships a breaking change, thousands of teams each dig through the changelog, find every call site and pray. YC calls the fix *self-maintaining APIs*: Dependabot for APIs. We think that agent shouldn't run alone in a private chat." |
| **0:15–0:22** | Click **⚡ Publish PayCo 2.0.0**. The room opens. | "So this is **Patchroom**. PayCo just published 2.0: charges become payments, dollars become integer cents. Patchroom finds every subscribed repo and opens a *live room* for each one." |
| **0:22–0:30** | Paste the room URL into the right window with `?as=Junho`. Point at the avatars top-right and the "Junho is watching" toast. | "This is multiplayer AI. Junho from PayCo's DevRel drops into the same session. We both see the agent's steps stream in, with presence, like a Google Doc." |
| **0:30–0:45** | The timeline runs: *Cloned → Scanned 12 usages in 6 files → Bumped SDK → 6 failing*. | "It cloned our real repo, found twelve call sites, bumped the SDK, and proved the break: six tests are red. Now it plans: watch out for float-to-cents, currency is now required." |
| **0:45–1:05** | As the first **PATCH** diff appears, type in **Junho's** window: `Also add a test that a pro renewal charges exactly 2900 cents.` ↵. The tag shows *queued* in both windows. | "Junho knows the classic bug from other customers, so he steers mid-run. Anyone in the room can. The message is queued, and the agent picks it up at its next step boundary." |
| **1:05–1:20** | The **STEER** card appears: the agent replies to Junho by name and lists the files it will touch. The tag changes to *acknowledged*, then *applied ✓*. | "The agent acknowledges publicly, says exactly what it will do, re-queues those files, and applies the instruction to every patch from then on. That's the difference from a private chat: the context of the whole team lands in the code." |
| **1:20–1:35** | Diffs keep streaming. **Ran the test suite → ✓ 9 passing**. The **Ship it?** box appears in both windows. | "All green, including Junho's new test. But it doesn't push on its own. A human in the room has to approve." |
| **1:35–1:45** | In **Min's** window, click **Approve → open PR**. The PR card appears and CI is pending. | "I approve, and it pushes a branch and opens a real GitHub pull request." |
| **1:45–1:55** | Click the PR link. Show the PR body ("Steered live by the team: Junho …", "approved by Min") and the green **test** check. | "The PR credits who steered and who approved, and GitHub Actions is green. One provider change, every customer patched, together. That's Patchroom." |

**Fallback lines if CI is slow:** "CI is running on GitHub right now. Here's the previous green run." Open the PR's Checks tab.

---

## Exact steering line to type (copy-paste)

```
Also add a test that a pro renewal charges exactly 2900 cents.
```

Alternative steering lines that also work:
- `Keep the variable names as charge — don't rename locals.`
- `Tips should be in EUR, not USD.`

## Reset between takes

```bash
gh pr list --repo METHEZONE/patchroom-demo-shop --state open --json number --jq '.[].number' \
  | xargs -I{} gh pr close {} --repo METHEZONE/patchroom-demo-shop --delete-branch
```

Restart `npm start` if you want an empty lobby. Rooms live in memory.

## Judging hooks (say them if there's Q&A)

- **Problem-solution clarity:** this merges two YC RFS: Self-Maintaining APIs and Multiplayer AI (QM-style shared sessions).
- **Technical execution:** it's all real: git clone, SDK bump, red tests, LLM patches streamed token by token, a self-repair loop, `gh pr create`, and a CI poll. The event-sourced room means late joiners replay the exact state.
- **Creativity:** the provider's DevRel and the customer's engineer meet *inside* the agent session. The PR is a record of the collaboration, not just the diff.
