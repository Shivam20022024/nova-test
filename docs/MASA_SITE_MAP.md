# Masa (dev.masa.life) — site map for NovaTest

Inspected 2026-10-16 in a signed-in browser (account: Masa Core / Free, "Natural cycle", display name EvaTest).
Method: page DOM + accessibility roles/names, SPA route walk, opening (never saving) every dialog/form.
Nothing was saved, deleted, purchased or signed out during the inspection.

## 1. How the site behaves (affects every test)

| Fact | Detail | Why it matters to NovaTest |
|---|---|---|
| Single-page app (React) | Client-side routing, no full reloads between pages. First paint is a bare "Loading…" screen. | Steps must wait for real content. Login form appears 2–10 s after load; `/cycle` needs 5–9 s. |
| Dev banner | Orange "DEV ENVIRONMENT — NOT PRODUCTION DATA" on every page. | Harmless; shows on blank pages too (a blank page with only the banner = app did not render). |
| Cloudflare Turnstile | On `/login`. Dev now uses Cloudflare *test keys* (widget shows "Success!" + red "For testing only" line). | Passes for NovaTest now. The "Sign in" button needs the token first — wait for "Success!" before clicking. |
| Two "Sign in" controls | A tab at the top of the card and the real submit button under the Cloudflare box. | `getByRole('button',{name:/Sign in/i}).first()` hits the TAB. Must target the submit button. |
| First-visit tour | Dialog "Here's where things live." with **Got it** (submit) and **Close**. Shown once per *browser profile* (appears in every fresh automation browser). | Blocks clicks behind it. Every signed-in test must dismiss it first. |
| Dynamic element ids | Search inputs use React ids like `_r_21_`, `_r_8t_` — they change per render. | Never select by id for those. Use placeholder/label/role. |
| CSS-uppercased labels | `innerText` shows `UPGRADE MY PLAN`, `TRY PRO FREE — 14 DAYS`, category rows `YOUR BODY · 11 ARTICLES`; the DOM text is mixed case. | Match case-insensitively. |
| Toasts | Region "Notifications alt+T" (toast library). Short-lived. | Assert toast text immediately after the action, with a short timeout. |
| Time/data dependent text | Greeting (`Good morning/afternoon/evening, <name>.`), `Day <n> · Natural cycle · next test in <n> days`, header date, month grid, "Past appointments (n)", article counts. | Assert with patterns, never exact strings. |
| Concurrent logins | In the 2026-10-16 batch (4 browsers signing in to the *same account at once*), the recorded run for MASA-07 ended on a blank page (only the dev banner) after the Sign in click; 9 of 11 runs stalled after login the same way (only MASA-07 was checked on video). A single run earlier reached Today. | Unproven cause (concurrency vs Masa-side). Run signed-in scenarios one at a time until a single-run test is done. |

## 2. Routes and what is on them

Header on every signed-in page: logo link, "Masa Core profile" avatar link (`/profile`), **Sign out** button (aria-label), tabs **Today `/`**, **Journey `/journey`**, **Care `/care`**, **More `/more`**.

| Route | Title / H1 | Interactive elements (role · name) | Notes |
|---|---|---|---|
| `/login` | Sign in — Masa | tab "Sign in", tab "Create account", button "Continue with Google", input[type=email] label EMAIL, input[type=password] label PASSWORD, link "Show", Turnstile box, submit "Sign in", link "Forgot your password?" | email/password inputs have **no `name`/`id`** — use type/label |
| `/` Today | "Good <time>, <name>." | link "See what changed" (`/whats-new`), button "Dismiss what's new", button "Save this message", link "ALL SAVED" (`/saved-messages`), textarea "A line for today. Private. Just for you.", submit "Save" (**disabled until text is typed**), button "Cycle calendar" (opens dialog with month grid), links "Log temperature" (`/cycle#bbt`) and "How you're doing" (`/cycle#feelings`), button "Nothing on the calendar. Add one.", link "Read: The two-week wait", button "Dismiss for this week", link "SEE PAID FEATURES" | tour dialog on first visit |
| `/journey` | My Journey | button "change" (dialog), link "My journey history →", link "CURRENT CYCLE …" (`/cycle`), link "MY CARE TEAM …", link "Calendar", button "Past appointments (n) ▾" | "change" dialog contains **End this cycle**, **Mark as a loss** (destructive) and "Never mind, stay here" |
| `/care` | Care | 6 cards (links): Care team `/care-team`, Appointments `/calendar`, Learn `/learn`, Glossary `/learn/glossary`, My journals `/journal`, My journey history `/past-cycles?from=care` | |
| `/more` | More | 9 links: Profile `/profile`, Membership `/subscription`, Settings `/settings`, Saved messages `/saved-messages`, How Masa works `/how-masa-works`, What's new `/whats-new`, Share your story `/share-your-story`, Questions and Feedback `/help`, About Masa `/about` | |
| `/profile` | H1 = display name | button "Close", links Profile `/profile/edit`, Membership, Security `/security`, button "Sign out Your data stays." | |
| `/profile/edit` | Profile | Back, "Change profile photo", "Add a photo", disabled input Email, "Change email", input Display name (`name=name`), "Change password", Save, input Birth year (number, `birth-year`), Save | two "Save" submits |
| `/subscription` | Your membership | Back, "What's included", link "UPGRADE MY PLAN" (`/subscription/plans`) | shows "Masa Core / Free / Current", "How billing works" |
| `/subscription/plans` | Compare all plans | "Purchase Masa Charter", "TRY PRO FREE — 14 DAYS", price toggles `$118.64/YR`, `$16.94/MO`, `$182.20/YR`, `$8.47/MO`, `$90.68/YR`; links Terms, Privacy, How Masa works, support@masa.life | **Payments** — never click Purchase/Try in a live account. Price buttons are ambiguous (many `/MO`, `/YR`). |
| `/security` | Security | Back, switch "Enable biometric login" (disabled, "Coming soon"), input Label (`mfa-name`), "Add authenticator", "Sign out all other devices", "Sign out everywhere" | "Sign out everywhere" ends the test session |
| `/calendar` | Appointments | Add, search "Search appointments…", Filter, `<summary>` "PAST (n)", Previous/Next month, Jump to today, **31 day buttons named `1`…`31`** | |
| `/calendar` → Add | dialog "Add appointment" | input Title, combobox(button) "—" (type), input[type=date], switch "All day", comboboxes "9" / "00" / "AM", combobox "Doesn't repeat", input "Notes (optional)", Cancel, Save, Close | **custom comboboxes, not `<select>`** |
| `/calendar` → Filter | popover | 22 type chips: Natural, IUI, IVF, Pregnancy, Postpartum, Cycle, Resting, Labs, Scan / ultrasound, Monitoring visit, OB visit, Midwife visit, Insemination, Egg retrieval, Embryo transfer, Beta draw, Pediatrician, Lactation consultant, Mental health, Gynecologist visit, Primary care (PCP), General / other | |
| `/care-team` | Care team | Back, Add → dialog "Add provider": Name (`ct-name`), "Select or type a role…", "Search or type your clinic", Address (`ct-address`, combobox textarea), Phone (`ct-phone`), Notes (`ct-notes`), Cancel, Save, Close | |
| `/cycle` | This cycle | accordions "Cycle calendar ▾", "Milestones ▾", "Pregnancy tests ▾", "BBT ▾", "RECENT ENTRIES (n) ▾"; date input (`page-log-date`); flow chips None/Spotting/Light/Medium/Heavy; Period/Aunt Flow; pregnancy test Positive/Negative/Not now; "Definition: Mucus", "What do these mean?"; 2 comboboxes "—"; "Also track cervix position"; switches Intercourse/Ov pain/Tender breasts/Nausea; **two "Nothing to save yet" submits (disabled until something is chosen)**; BBT number input (97.50), time input, method Oral/Vaginal/Rectal/Wearable (skin), "Nothing affected this reading"/"Something may have affected it"; Print; `<summary>` History; per-entry **Edit** and **Delete** buttons; ~25 symptom/mood chips (cramping, spotting, … calm) | 5–9 s load. Deep links `#bbt`, `#feelings`. Delete is destructive; Edit/Delete repeat per entry. |
| `/past-cycles` | My journey history | "‹ Back", "See plans", link "Open Natural cycle from Sep 1 to Sep 29" | detail at `/past-cycles/<uuid>` |
| `/journal` | Journal | Back only (empty) | |
| `/saved-messages` | Saved messages | (empty list) | |
| `/whats-new` | What's new | Back, accordion "JULY 24 Late July Updates ▾" (`aria-expanded`, open by default; click collapses) | |
| `/learn` | Learn | Back, search "Search articles and terms", link "Browse the A–Z glossary", 14 category accordions (`aria-expanded`): START HERE (5), YOUR BODY (11), UNDERSTANDING YOUR RESULTS (3), THE WAIT (1), YOUR MIND (2), CHOOSING YOUR PATH (2), IUI (11), IVF EXPLAINED (3), IVF FOR EGG PRESERVATION (2), FOR HIM (4), PREGNANCY (9), POSTPARTUM (4), THE SEASON BETWEEN (2), AFTER LOSS (1), LOSS (5). Expanded → article links (some with a "PRO" badge in the name) | counts change as content is added |
| `/learn/<slug>` | article title | Back, "EXPLORE LEARN", "SAVED", "Save this read", "Share <title>", "Definition: <term>" buttons, external source links | e.g. `/learn/the-two-week-wait` |
| `/learn/glossary` | Glossary | Back, search "Search the glossary", "Read more →", many `<summary>` "Source" accordions, **external links with no text** | search input id is dynamic |
| `/settings` | Settings | unit radios (°F/°C, cm/ft·in, kg/lbs), period wording (Period / Aunt Flow), 4 colour swatches (Warm Mist, Warm Ivory, Pale Stone, Dusty Lavender), daily message (Faith-based / Secular / Neither), week-start combobox + hidden native `<select>`, 7 switches (rainbow baby, size-of-fruit, everyday-object, celebrate milestones, open calmly at night, add to calendar, browser notifications), **Download my data**, **Reset my data**, **Delete my account**, "Save settings" | every switch/radio is a *pair*: a `button` + a hidden `input` |
| `/share-your-story` | Share your story | textarea YOUR WORDS (`story`), FIRST NAME (`first-name`), LAST INITIAL (`last-initial`), combobox "Trying to conceive" + hidden native select, "Send my story" (disabled until filled) | **Publishes** user text — never submit |
| `/help` | Questions and Feedback | textarea YOUR MESSAGE (`feedback`), "Attach screenshot" (file), "Send" (disabled until typed) | sends a message to the team |
| `/how-masa-works`, `/about`, `/terms`, `/privacy-policy`, `/accessibility` | content pages | headings only + links (`/terms` H2 1–21 + "Version history"; `/privacy-policy` H2 1–17) | safe read-only |

## 3. Action safety classes (use in prompts and sheets)

- **Read-only (safe):** every `goto`, tab/menu navigation, opening accordions (`aria-expanded`), opening a dialog and clicking Cancel/Close, typing into a field without saving, Filter chips, month navigation.
- **Writes real data (only with explicit consent and real values):** Today journal **Save**, **Save this message**, Add appointment **Save**, Add provider **Save**, cycle logging **Save** buttons, profile **Save**, Settings **Save settings**, "Dismiss what's new", "Dismiss for this week".
- **Destructive (never automate on a live account):** Journey → **End this cycle**, **Mark as a loss**; cycle history **Delete**; Settings → **Reset my data**, **Delete my account**, **Download my data**; Security → **Sign out everywhere**, **Sign out all other devices**; header **Sign out**.
- **Financial / outbound (never):** **Purchase Masa Charter**, **TRY PRO FREE — 14 DAYS**, price toggles that start checkout; **Send my story**, **Send** (help), "Change email", "Change password", "Add authenticator".

## 4. Stable locators to use

| Element | Locator that is unique and stable |
|---|---|
| Email field | `input[type="email"]` or label EMAIL |
| Password field | `input[type="password"]` or label PASSWORD |
| Login submit | `form button[type="submit"]` (text "Sign in") — not the tab |
| Tour dismiss | button text "Got it" |
| Main tabs | `a[href="/journey"]`, `a[href="/care"]`, `a[href="/more"]`, `a[href="/"]` |
| Today journal | textarea placeholder "A line for today. Private. Just for you." |
| Page titles | `h1` text (see table) |
| Appointment type / time / repeat | `button[role="combobox"]` inside the "Add appointment" dialog (open it, then click the option) |
| Learn category | `button` whose text starts with the category name; check `aria-expanded` |
| Switches | `button[role="switch"]` (name = visible label) — ignore the paired hidden `input` |
