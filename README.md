# SEC Transmission – Work Order & Maintenance System (MVP)

A bilingual system (Arabic RTL / English LTR) for transmission work orders, before/after photos, warehouse materials, approvals, email alerts and Excel/CSV import/export. It is built from the requirements in *SEC_Transmission_Advanced_Prompt_Bilingual_v1.1* and covers sections 4, 5, 6, 7, 9, 10, 12, 16 (approvals), 18, 21, 22 and 25.

> **Test environment.** Everyone in the seed data is fictional: F001–F070 come from Appendix B, and the managers are `DEMO-*` placeholders. The real names in Appendix A are left out on purpose and should only be entered after formal verification.

## Run it

Requires **Node.js 22.13+**. The database is SQLite through the built-in `node:sqlite`, so there is nothing native to compile.

```bash
npm install
npm start            # http://localhost:3000  (seeds sample data on first run)
npm test             # business-rule tests on a throwaway database
npm run reset        # wipe and reseed the database
```

All demo accounts use the password `Demo@12345`:

| Login | Role |
|---|---|
| `admin` | System administrator (settings, import/export, outbox, audit) |
| `DEMO-H1` … `DEMO-H9` | Section heads (direct supervisor) for sections H1–H9 |
| `DEMO-DV1` / `DV2` / `DV3` | Division managers (Lines / Substations / Facilities) |
| `DEMO-DM` | Department manager |
| `DEMO-SH` | Sector head |
| `F010`, `F006`, `F014`, … | Team leaders |
| `F001` … `F070` | Employees |
| `DEMO-WH` | Warehouse (verifies reservations) |
| `DEMO-HR` | HR (employees, leave, acting assignments) |
| `DEMO-AUD` | Auditor (read-only + audit log) |

## Deploying on Hostinger

See **[DEPLOY_HOSTINGER.md](DEPLOY_HOSTINGER.md)** (Arabic + English).

There are three ways to deploy:
- **Hostinger VPS** with `deploy/setup-vps.sh` (PM2 + Nginx + HTTPS + daily backups) and automatic deployment from GitHub Actions.
- **hPanel Node.js Web App**, imported straight from GitHub.
- **Docker** (`docker compose up -d`).

How production behaves:
- With `NODE_ENV=production` the system **starts empty**: no sample data, only an `admin` account whose password comes from `ADMIN_PASSWORD`.
- Login cookies only work over HTTPS (`Secure` flag).
- The database and photos live in `DATA_DIR`, outside the code folder, so updates never touch them.
- `npm run backup` takes a consistent backup while the app is running. `/healthz` is the health check.

Sample data is used only for local runs, or when you set `SEED_DEMO=true`.

## Email and alerts

Every event raises an in-app alert (the 🔔 badge refreshes every 30 s and can show browser notifications). The same alert is also emailed in Arabic and English, with the work-order details and a link back to the system.

Emails go out over SMTP when it is configured. Without SMTP, each email is kept in **Email Outbox** (`/outbox`) so you can read exactly what would have been sent.

```bash
SMTP_HOST=smtp.office365.com SMTP_PORT=587 SMTP_USER=wms@company.com SMTP_PASS=*** \
MAIL_FROM="Transmission WMS <wms@company.com>" APP_URL=https://wms.company.com npm start
```

Use **Settings → Send test email** to check the connection. Each user can switch email off from their profile; in-app alerts always stay on.

| Event | Who is alerted |
|---|---|
| Work order assigned (created or imported) | Every team member + team leader (email with full WO details) |
| New WO in section | Section head |
| Critical case C1–C4 created | Division manager, department manager, safety |
| Critical response 75 % elapsed / breached | Team, section head → escalation to division & department managers |
| Approval requested / reminder every 24 h | The approver currently in charge (an active acting manager takes the place of the permanent one) |
| Approved, rejected, closed, cancelled | Team and creator |
| Assignment > 20 in a distance category | Department manager (review) → sector head |
| Possible task-splitting detected | Section head, division manager |
| Unexplained material variance blocks closure | Section head, division manager, warehouse |
| New or unverified reservation | Warehouse |
| Past planned end / not started / no "before" photo after 4 h | Team leader, section head |
| Leave recorded that clashes with active work | Team leader, section head |
| Equipment expired or expiring (30 days) / calibration due | Admin, safety |
| Acting assignment started / ending in 3 days | Acting employee, HR |
| Temporary repair closed (needs follow-up) | Section head, division manager |
| WO number sequence near WO999999 | Admin |
| Broadcast (Settings) | Everyone or one role |

Scheduled checks run every minute, and each condition alerts only once. All thresholds (SLA hours, the 20-assignment limit, reminder intervals, expiry days) can be changed in **Settings**.

## Import and export (`/data`)

Data types: organization structure, employees, **training courses**, **course attendees** (registers people and books their absences), improvement plans (export), leave/training/workshops/factory tests (with remote/in-person), acting assignments, **holidays**, **point requests**, assets, equipment, **work orders**, **material lines**.

1. **Download template**. The `.xlsx` has a data sheet plus an *instructions* sheet in both languages. Required columns are shown in red.
2. Fill it in Excel, or upload a `.csv` (UTF-8, Arabic is fine).
3. **Upload & preview**. Every row is checked: unknown employee/section/asset, invalid dates, leave conflicts, expired equipment, duplicate WO numbers, the reservation rules and so on. Each row shows `+` insert, `~` update or ❌ with the reasons.
4. **Confirm import**. Valid rows are committed and show up across the system immediately. Imported work orders get `WO` numbers and email their teams. The result of each row is kept in the import history.

How rows are matched:
- Employees are matched on `employee_no`, and assets and equipment on `code`, so an existing record is updated and a new one is inserted.
- Imported work orders are always new. Leave `wo_number` empty and the system numbers them. Only `admin` may import historical numbers, and the sequence then moves past them.

Exports are `.xlsx` or `.csv` (with a BOM so Excel shows Arabic correctly). The work-order export follows the filters on the list page and includes the officials in charge at the time of the work, photo counts and reservations. Phone numbers are masked for users other than HR/admin. `admin` and `auditor` also get a **full export** with every data type in one workbook. Every export is logged in the audit log.

## Work-order rules in this build

- **Numbering.** The format is `WO` + 6 digits, generated when the work order is first saved. The number can never be edited, deleted or reused, even after cancellation; database triggers enforce this. Generation stops at WO999999, with alerts beforehand.
- **Creation checks.**
  - Team members on approved leave, training or permission, or with overlapping work, cannot be assigned.
  - Equipment that is expired, under maintenance, due for calibration or already booked cannot be assigned.
- **Distance.** Categories are <100, 100–200 and >200 km. When any team member would go past 20 assignments in the 100–200 or >200 category this year, the WO waits for department-manager review and then sector-head authorization. Over 200 km, a selection reason is also required.
- **Materials.**
  - The "Were materials withdrawn?" question is mandatory. Answering Yes requires a reservation number, and the warehouse must verify it before work can start.
  - Material lines track issued, used, returned, damaged and transferred quantities.
  - Closure is blocked until issued = used + returned + damaged + transferred + authorized remaining.
  - Every edit needs a reason and is audited.
- **Photos.**
  - Before, during and after photos. Several can be uploaded at once, straight from the phone camera, with GPS when the browser allows it.
  - A SHA-256 hash of each file is stored. Each after photo can be linked to its before photo, and the pair is shown in a side-by-side slider.
  - Photos are locked once the WO is submitted for closure.
- **Closure.**
  - A WO cannot close without: before and after photos, an action description, a result, participants, and the materials questions answered and reconciled.
  - Critical cases also need arrival and restoration times.
  - Approval chain: team leader → section head → division manager (critical cases). Each approval stores the approver, the date, whether they were acting, and a verification code.
- **Historical officials.** Each WO stores a snapshot of the section head, division manager, department manager and sector head on the day it was created, including acting managers. `/acting` answers "who was in charge on date X?".
- **Audit.** Every create, update, approval, import, export and login goes to a log that cannot be changed or deleted (enforced by database triggers).

## Menu layout

| Group | Pages |
|---|---|
| **Operations** | Dashboard · Work Orders · New Work Order · Work Activity · Travel Assignments · Team Calendar · Alerts |
| **People** | Employees · Leave & Absences · Training Courses · Improvement Plans · Points & Ratings · Acting Assignments · Organization |
| **Assets & Fleet** | Assets · Vehicle Fleet · Devices & equipment |
| **Administration** | Permissions · Import & Export · Email Outbox · Audit Log · Settings |

Everything is connected and updates in real time:
- **Training registrations** create a training absence that shows on the calendar and blocks conflicting work.
- **Closing a work order** awards points. Ratings then create improvement plans, and those plans drive the course suggestions.
- **Extensions and handovers** re-check availability and notify everyone involved.

## Travel assignments (`/travel`)

**The new work-order question:** "Does the job involve travel?" (required).
- **No:** the distance must be under 100 km.
- **Yes:** choose the band **Over 100 km** (100–200 km) or **Over 200 km** (more than 200 km) and enter the round-trip distance, travel hours and whether there is an overnight stay.
- **Validation:** the browser and the server both reject a distance that doesn't match the band (for example 150 km marked "Over 200 km"). Excel/CSV imports of work orders take the same `involves_travel` / `travel_band` columns and are validated the same way.

**The Travel Assignments page** (Operations menu) is built entirely from work orders.
- **Totals per band:** jobs, kilometres, overnight stays, travel hours, and how many jobs needed Sector Head approval.
- **Per employee:** a meter for each band (n / 20) with a status: Within limit, Near the limit (16+), Limit reached (20) or Over the limit (21+). Each employee links to their list of travel work orders.
- **Filters and export:** by band, year and section. The Excel export has both the per-employee sheet and the work-order sheet.
- **Who sees what:** managers, team leaders, HR and auditors see everyone; employees see only their own travel. HR can grant extra access through the Permissions page (`travel.view_all`, which can be limited to one section).

**Alerts**
- **When:** an employee reaches 20 assignments in a band, and again on every assignment beyond 20.
- **Who:** the employee, their section head (including an acting head), the division manager and the department manager are alerted in-app and by email.
- **Timing:** this happens immediately when a work order is created, and the every-minute scheduler also catches imports and handovers.
- **Approval:** the 21st assignment and later in a band still go through Department Manager review and Sector Head approval. The limit of 20 can be changed in Settings.

## Work order extension and handover (work order page → "Extension & hand-over")

**Extension**
- The team or the section managers can change the planned end date/time, and the start too if work hasn't begun yet.
- The new period is re-checked for leave, courses, other work orders and vehicle bookings before anything is saved.
- A request from a team member goes to the section head for approval; a manager's own change applies immediately. Everyone involved is notified.
- Requests still pending after 24 h trigger a reminder. Each extension stays on the work order's history and in the printed report.

**Handover**
- The team leader or a section manager picks the receiving employee, the date and time, the reason, and the state of the work at handover. They can also choose whether the outgoing person stays on the team.
- The receiver must be free from the handover time until the work ends.
- Both people get an alert 1 hour before. At the set time the system switches the team leader automatically (scheduler runs every minute), records it in the audit log, and notifies the team and section head.

## Vehicle fleet (`/fleet`)

- **Vehicle records:** fleet number, plate, type (pickup, crew cab, bucket truck, crane truck, line truck, van…), make/model, year, seats, assigned section, status, and registration/insurance expiry.
- **Live status:** each vehicle shows whether it is on a job now, its next bookings and completed jobs.
- **Summary counts:** available, in use, under maintenance, expired, and total available seats.
- **In the New Work Order form:** vehicles are picked as cards (plate, type, seats). A live summary shows the team leader, number of people, number and types of vehicles with plates, and total seats. It warns when there aren't enough seats.
- **On the work order itself:** the page and printed report show the crew & vehicles summary and a vehicle table.
- **Blocked automatically:** expired, under-maintenance or already-booked vehicles can't be assigned.

## Employee directory

- **Adding employees:** `Employees → Add employee` is a full form: employee ID, national ID, Arabic/English names, nationality, email (required), phone, section, role, job titles, grade, hire date, employment type, shift, status, notes and an initial password.
  - Employee IDs and emails must be unique, and emails are format-checked.
  - The new employee gets a welcome email with their login ID (the password is never emailed), and the section head is notified.
- **Editing:** profiles have an Edit button. Changing someone's section notifies them.
- **Bulk import:** use Import & Export → employees.

## Training courses (`/training`)

- **Catalogue:** local and international courses (the course list from the requirements is pre-loaded), each with country/city, remote or in person, provider, dates, hours, capacity and cost.
  - Each course lists its attendees with attendance, result, score and certificate number.
  - The page shows yearly totals: courses, international courses, employees trained, attendance, pass rate and hours.
- **Registering an employee:**
  - The course days must be free (no other leave or work).
  - A linked *training* absence is created, so the course appears on the calendar and on any affected work order's "away" list.
  - The employee is emailed and the section head is notified.
  - Moving or cancelling a course updates or cancels everyone's linked absences.
- **Suggested improvement for employees** (bottom of the page):
  - Priority: employees on an improvement plan, rated Satisfactory/Acceptable, or below the opening balance.
  - General: employees with no training in 12 months.
  - Each suggestion offers upcoming courses that match the employee's section specialty, with a one-click Register button. Suggestions are advisory; a person decides.

## Improvement plans (`/plans`)

- **When plans open:** automatically for employees rated **Satisfactory** or **Acceptable** (and anyone below the 10,000 opening balance). Each plan has goals, actions/suggested courses and a coach (the section head).
- **Annual review:** runs automatically each January for the previous year; HR can also run it from the page.
  - **Good or better:** the plan closes as *Improved*.
  - **Not improved:** the plan continues (year 2, year 3).
  - **No improvement after 3 years:** a **transfer to another department is recommended**, and HR and the department manager are alerted.
- **Transfers need a human decision.** HR / Department Manager / Sector Head either confirm the transfer (new section and decision number; the employee's section changes and everyone is notified) or extend the plan one year with a written justification.

## Permissions (`/permissions`)

- **Granting:** HR or the administrator can give individual employees extra permissions on top of their role. A grant can cover all sections or one section, can have an expiry date, and can be revoked. The employee is notified.
- **Available permissions:** view all work orders and their status; **view work-order updates and modifications** (the history and the **Work Activity** feed); view every team's calendar; view the points leaderboard; manage training; view improvement plans; manage the fleet; add and edit employees.
- **Defaults:** the page also shows a table of what each role gets by default.
- **Work Activity (`/activity`):** a live feed of every update on work orders (created, started, photos, materials, extensions, handovers, approvals, closure), filterable by work order number, section and type.

## Team calendar (`/calendar`)

One calendar for everything happening in a year:
- **Holidays.** Public and company holidays. Eid dates are marked *approximate* until the official announcement; HR and admin can add or remove holidays, or import them from Excel.
- **Work orders.** Each one appears on its planned days.
- **Absences.** Annual, sick and emergency leave; training courses (remote or in person); workshops (remote or in person); factory tests (with factory/country); permissions; business travel.
- **Acting managers.**

How to use it:
- **Year view:** 12 months at once. Holidays are red, weekends (Friday/Saturday) are shaded, and colored dots show work and absences, with a count when several people are away. Click any day to open that month.
- **Month view:** a full grid with a color-coded label for each event, plus an event list underneath. On phones it becomes a list of days that have events.
- **Filters:** by team (section), by employee, and by event type (the color legend doubles as the filter). Employees see their own team by default.
- **Export:** Excel, or **Outlook (ICS)** to subscribe in Outlook or a phone calendar.
- **Summary:** a year summary of events and days per type, a list of holidays, and a "next two weeks in my team" card on the dashboard.

## Who was away during a work order

Every work order has a **"Team members away during this work order"** section at the bottom, and it is also in the printed/PDF report. It lists everyone in the section (plus any team member) who was on annual/sick/emergency leave, a training course, a workshop, factory tests, a permission or business travel during the planned dates. Each entry shows the type, remote or in person, the location and the dates. It also lists public holidays in that period. The same information is a column in the work-order Excel export.

Creating a work order on a public holiday shows a warning. Approved absences still block assigning that person.

## Points and ratings (`/points`)

- **Opening balance.** Every employee starts each year with **10,000 points** (configurable).
- **Awards and deductions.**
  - Point values come from section 11 of the requirements, such as safety meeting +50, drill +150, project completion +1,500, safety violation −800 and traffic violation −3,000.
  - A team leader, manager, safety officer or HR requests an award or deduction with a reason and reference. It only counts after a **Division Manager or HR approves** it. People cannot request points for themselves or approve their own requests.
  - Safety-meeting attendance is capped at 600 points a year.
- **Automatic points.** When a work order is closed (after all approvals), each team member automatically gets +100 points (+200 for critical cases).
- **No direct editing.** Balances are never edited. Mistakes are fixed with a reversal (HR, Department Manager or Sector Head). Employees can appeal a deduction once, and every action is audited.
- **Ranking.** Employees who **exceed 10,000** are ranked and marked *Awarded*. The highest ranks get the highest ratings. The default is 2 per rating: #1–2 Excellent, #3–4 Very good, #5–6 Good, #7–8 Satisfactory, #9 onwards Acceptable. The number per rating can be changed on the points page. Equal balances share the same rank and rating.
- **Below the opening balance.** Employees under 10,000 are flagged *below opening balance*, so they can get a development plan.
- **Pages.** A leaderboard with a top-3 podium, each employee's points statement, a "my points" card for everyone, and an Excel export. Requests can also be imported in bulk (`point_requests`); they still need approval.

## Design system

- **Style:** a data-dense enterprise dashboard. The theme is light by default, with dark mode from the moon/sun button in the top bar (it follows the device setting until a user chooses).
- **Colors:** transmission blue (`--primary`) with a high-voltage amber accent (`--volt`). Status colors are green for OK, amber for warnings or maintenance, red for incidents/critical, and violet for in progress. Every color is a CSS variable at the top of `public/style.css`, with dark-mode values alongside.
- **Type:** IBM Plex Sans Arabic for both Arabic and Latin text; IBM Plex Mono for WO, reservation and material numbers. Falls back to system fonts when Google Fonts is blocked.
- **Icons:** an inline SVG sprite in `views/partials/icons.ejs` (Lucide style), used through `ic('name')`. No emoji are used as icons.
- **Accessibility:**
  - Visible focus rings and a skip-to-content link.
  - Controls are at least 40–44px tall, and 16px inputs on mobile stop iOS from zooming in.
  - Status is shown by text plus color, never color alone. Animation is turned off when the device asks for reduced motion.
  - The before/after slider can be moved with the keyboard.
- **Layout:** right-to-left and left-to-right layouts both use CSS logical properties. On mobile the sidebar opens as a slide-out drawer (Esc closes it). Pages were checked at 390px wide with no sideways scrolling.

## Project layout

```
src/
  server.js          Express app, sessions, language, schedulers
  db.js              SQLite schema, immutability triggers, settings
  workorders.js      numbering, validation, distance rule, closure checklist, approvals
  alerts.js          scheduled alert checks
  notify.js          in-app alerts + email queue (SMTP or outbox)
  entities.js        import/export definitions and per-row validation
  importexport.js    xlsx/csv parse, templates, export
  routes/            dashboard, workorders, people, registry, data, system
views/               EJS pages (Arabic RTL / English LTR)
public/              CSS + client JS (photo slider, GPS, alert badge)
test/                node:test business-rule tests
uploads/             photo files (keep them on backed-up storage)
data/app.db          SQLite database
```

## Not built yet (later phases from the requirements)

Contractors and contracts (§13), electrical isolation and work permits (§14), contractor-project supervisor handover (§15; work-order handover is built), safety meeting records (§11.1; the points system is built), the training course catalogue (§6.3–6.4), annual evaluation (§17), the annual archive and year comparison (§19), the AI assistant (§20), drawing arrows/circles on photos, QR-coded stamps, MFA and SSO, and ERP/warehouse integration.

Before production: set `COOKIE_SECURE=true` behind HTTPS, replace the demo password, move SQLite to managed storage (or port to PostgreSQL), back up `uploads/`, and get formal approval for the policy values in Settings.
