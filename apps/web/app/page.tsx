"use client";
import { useEffect, useState, useCallback } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  LayoutGrid,
  Bookmark,
  CalendarDays,
  Send,
  Inbox,
  ChartNoAxesCombined,
  Workflow,
  Settings,
  Radio,
  Bell,
  Check,
  CheckCircle2,
  Clock,
  FileText,
  Plus,
  X,
  ChevronRight,
  RefreshCw,
  LogOut,
  ShieldCheck,
  ExternalLink,
  LoaderCircle,
  SlidersHorizontal,
  Upload,
  Mail,
  AlertCircle,
  Leaf,
} from "lucide-react";
type Tab =
  | "all"
  | "new"
  | "shortlisted"
  | "deadlines"
  | "applied"
  | "responses"
  | "analysis"
  | "sources"
  | "activity"
  | "settings";
const tabs: Array<{ id: Tab; label: string; icon: any }> = [
  { id: "all", label: "Discover", icon: LayoutGrid },
  { id: "shortlisted", label: "Shortlisted", icon: Bookmark },
  { id: "deadlines", label: "Deadlines", icon: CalendarDays },
  { id: "applied", label: "Applications", icon: Send },
  { id: "responses", label: "Responses", icon: Inbox },
  { id: "analysis", label: "Insights", icon: ChartNoAxesCombined },
];
async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
    credentials: "include",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const post = (path: string, body: any = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
const fmtStatus = (s: string) => s.replaceAll("_", " ");
const safeLink = (s: string) => (/^https?:\/\//i.test(s) ? s : "#");
const comparableMonthlyPay = (l: any) =>
  l.currency === "INR" && l.stipendAmount !== null
    ? l.paymentPeriod === "month"
      ? l.stipendAmount
      : l.paymentPeriod === "week"
        ? (l.stipendAmount * 52) / 12
        : -1
    : -1;
function deadline(s: string | null) {
  if (!s) return "Not specified";
  const days = Math.ceil((Date.parse(s) - Date.now()) / 86400000);
  return days < 0
    ? "Deadline passed"
    : days === 0
      ? "Due today"
      : `${days} days left`;
}
function pay(l: any) {
  if (l.stipendAmount == null) return "Pay not specified";
  return `${l.currency === "INR" ? "₹" : l.currency || ""}${Number(l.stipendAmount).toLocaleString("en-IN")} / ${l.paymentPeriod === "month" ? "mo" : l.paymentPeriod}`;
}
export default function Home() {
  const [user, setUser] = useState<any>(undefined),
    [data, setData] = useState<any>(null),
    [tab, setTab] = useState<Tab>("all"),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("fit"),
    [filter, setFilter] = useState("all"),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<any>(null),
    [notifications, setNotifications] = useState(false),
    [profile, setProfile] = useState<any>(null),
    [authMode, setAuthMode] = useState<"login" | "register">("login"),
    [caps, setCaps] = useState<any>({});
  const refresh = useCallback(async () => {
    try {
      const d = await api("/dashboard");
      setData(d);
      setUser(d.user);
      setCaps(d.capabilities);
      setProfile((p: any) => p || d.profile);
      setReview((a: any) =>
        a ? d.applications.find((x: any) => x.id === a.id) || a : null,
      );
    } catch (e) {
      if ((e as Error).message.includes("Sign in")) setUser(null);
      else setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    api("/auth/me")
      .then((d) => {
        setUser(d.user);
        setCaps(d.capabilities);
        if (d.user) void refresh();
      })
      .catch((e) => setError(e.message));
    const desired = new URLSearchParams(window.location.search).get("tab");
    if (desired === "settings") setTab("settings");
  }, [refresh]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [user, refresh]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  async function action(fn: () => Promise<any>, message?: string) {
    setError("");
    setBusy(true);
    try {
      const r = await fn();
      if (message) setToast(message);
      await refresh();
      return r;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function prepare(l: any, route = "web", recipient?: string) {
    const r = await action(() =>
      post(`/listings/${l.id}/prepare`, { route, recipient }),
    );
    if (r) setReview(r.application);
  }
  const pending =
    data?.jobs.filter((j: any) => ["pending", "running"].includes(j.status))
      .length || 0;
  const discoveryPending =
    data?.jobs.some(
      (job: any) =>
        ["pending", "running"].includes(job.status) &&
        ["discover", "extract", "match", "scan_source", "run_monitor"].includes(
          job.kind,
        ),
    ) || false;
  let listings = data?.listings || [];
  listings = listings.filter((l: any) => l.match.feedback !== "not_relevant");
  if (tab === "new") listings = listings.filter((l: any) => !l.match.feedback);
  if (tab === "shortlisted")
    listings = listings.filter((l: any) => l.match.shortlisted);
  if (tab === "deadlines") listings = listings.filter((l: any) => l.deadline);
  if (query)
    listings = listings.filter((l: any) =>
      `${l.title} ${l.company} ${l.skillsMust.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  if (filter === "remote")
    listings = listings.filter((l: any) => l.workMode === "remote");
  if (filter === "eligible")
    listings = listings.filter((l: any) => l.match.eligible);
  listings = [...listings].sort((a, b) =>
    sort === "pay"
      ? comparableMonthlyPay(b) - comparableMonthlyPay(a)
      : sort === "deadline" || tab === "deadlines"
        ? Date.parse(a.deadline || "9999-01-01") -
          Date.parse(b.deadline || "9999-01-01")
        : b.match.score - a.match.score,
  );
  if (user === undefined)
    return (
      <div className="loading">
        <LoaderCircle className="spin" />
        Starting your workspace…
      </div>
    );
  if (!user)
    return (
      <main className="login">
        <div className="login-story">
          <div className="brand">
            <span className="brand-mark">
              <Leaf size={22} />
            </span>
            autopilot<span className="brand-dot">.</span>
          </div>
          <div className="eyebrow">YOUR NEXT CHAPTER, WITH A LITTLE HELP</div>
          <h1>
            Less searching.
            <br />
            More possibilities.
          </h1>
          <p>
            A thoughtful internship workspace that finds opportunities, prepares
            your applications, and keeps every next step in view.
          </p>
          <div className="login-flow">
            <span>
              <Search size={19} /> Discover
            </span>
            <ChevronRight size={16} />
            <span>
              <FileText size={19} /> Prepare
            </span>
            <ChevronRight size={16} />
            <span>
              <ShieldCheck size={19} /> Review
            </span>
          </div>
          <div className="login-footer">
            <Radio size={15} /> Web workflows powered by TinyFish
          </div>
        </div>
        <div className="login-form">
          <div className="eyebrow">INTERNSHIP AUTOPILOT</div>
          <h2>
            {authMode === "login"
              ? "Welcome to your workspace."
              : "Start your next chapter."}
          </h2>
          <p className="muted">
            Your experience. Your applications. Your final say.
          </p>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const r = await action(() =>
                post(`/auth/${authMode}`, Object.fromEntries(f)),
              );
              if (r) {
                setUser(r.user);
                setProfile(null);
                await refresh();
              }
            }}
          >
            {authMode === "register" && (
              <label>
                Full name
                <input name="name" required autoComplete="name" />
              </label>
            )}
            <label>
              Email address
              <input name="email" type="email" required autoComplete="email" />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                minLength={authMode === "register" ? 10 : undefined}
                autoComplete={
                  authMode === "register" ? "new-password" : "current-password"
                }
              />
            </label>
            <button className="primary wide" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : null}
              {authMode === "login" ? "Sign in" : "Create workspace"}
              <ArrowRight size={17} />
            </button>
          </form>
          <button
            className="text-button"
            onClick={() =>
              setAuthMode(authMode === "login" ? "register" : "login")
            }
          >
            {authMode === "login"
              ? "New here? Create an account"
              : "Already have an account? Sign in"}
          </button>
          {caps.google && (
            <a className="button secondary wide" href="/api/auth/google">
              Continue with Google
            </a>
          )}
          {caps.mode === "demo" && (
            <>
              <div className="divider">or take a look around</div>
              <button
                className="secondary wide"
                disabled={busy}
                onClick={async () => {
                  const r = await action(() => post("/auth/demo"));
                  if (r) {
                    setUser(r.user);
                    setProfile(null);
                    await refresh();
                  }
                }}
              >
                Explore the demo <ArrowUpRight size={17} />
              </button>
              <p className="small muted">
                Uses a sample candidate and controlled employer. No real
                applications or emails are sent.
              </p>
            </>
          )}
        </div>
      </main>
    );
  if (!data)
    return (
      <div className="loading">
        <LoaderCircle className="spin" />
        Loading your workspace…
      </div>
    );
  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Leaf size={20} />
          </span>
          autopilot<span className="brand-dot">.</span>
        </div>
        <div className="workspace-label">
          <span className="avatar small-avatar">{user.name.slice(0, 1)}</span>
          <div>
            Your workspace<small>Internship journey</small>
          </div>
          <span className="tiny-chevron">⌄</span>
        </div>
        <div className="nav-caption">MY JOURNEY</div>
        <nav>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "nav-item active" : "nav-item"}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={18} />
              {t.label}
              {t.id === "shortlisted" && data.analytics.shortlisted > 0 && (
                <span className="nav-count">{data.analytics.shortlisted}</span>
              )}
              {t.id === "responses" && data.responses.length > 0 && (
                <span className="nav-count">{data.responses.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-caption second-caption">WORKSPACE</div>
        <nav>
          {[
            { id: "activity", label: "Agent activity", icon: Workflow },
            { id: "sources", label: "Sources", icon: Radio },
            { id: "settings", label: "Profile & settings", icon: Settings },
          ].map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "nav-item active" : "nav-item"}
              onClick={() => setTab(t.id as Tab)}
            >
              <t.icon size={18} />
              {t.label}
              {t.id === "activity" && pending > 0 && (
                <span className="status-dot pulse" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="tinyfish-card">
            <Radio size={17} />
            <div>
              TinyFish web agents
              <small>
                {caps.mode === "demo"
                  ? "Demo environment"
                  : caps.tinyfish
                    ? "Integration configured"
                    : "API key required"}
              </small>
            </div>
            <span
              className={
                "status-dot " +
                (caps.mode === "live" && !caps.tinyfish ? "amber" : "")
              }
            />
          </div>
          <button
            className="user-button"
            onClick={() =>
              void action(async () => {
                await post("/auth/logout");
                setUser(null);
                setData(null);
                setProfile(null);
              })
            }
          >
            <span className="avatar">{user.name.slice(0, 1)}</span>
            <span>
              {user.name}
              <small>Sign out</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />{" "}
            <span>
              {tabs.find((t) => t.id === tab)?.label ||
                {
                  activity: "Agent activity",
                  sources: "Sources",
                  settings: "Profile & settings",
                  new: "New opportunities",
                }[tab as "activity"]}
            </span>
          </div>
          <div className="top-actions">
            <span
              className={"mode-badge " + (caps.mode === "live" ? "live" : "")}
            >
              <span className="status-dot" />
              {caps.mode === "demo" ? "Demo mode" : "Live mode"}
            </span>
            <button
              className="icon-button"
              aria-label="Notifications"
              onClick={() => setNotifications(!notifications)}
            >
              <Bell size={19} />
              {data.notifications.some((n: any) => !n.read) && (
                <span className="notification-dot" />
              )}
            </button>
            <span className="avatar small-avatar">{user.name.slice(0, 1)}</span>
          </div>
        </header>
        <main className="content">
          {error && (
            <div className="error" role="alert">
              <AlertCircle size={18} />
              {error}
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {toast && (
            <div className="toast" role="status">
              <CheckCircle2 size={17} />
              {toast}
            </div>
          )}
          {caps.mode === "demo" && (
            <div className="demo-banner">
              <span>DEMO WORKSPACE</span> Listings and replies are simulated.
              Form filling and submission use a real local browser.
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setTab("settings");
                }}
              >
                Integration settings <ArrowUpRight size={13} />
              </a>
            </div>
          )}
          {["all", "new", "shortlisted", "deadlines"].includes(tab) && (
            <>
              <div className="page-heading">
                <div className="eyebrow">A LITTLE MOMENTUM GOES A LONG WAY</div>
                <div className="heading-row">
                  <div>
                    <h1>
                      {tab === "shortlisted"
                        ? "Worth a closer look."
                        : tab === "deadlines"
                          ? "Make the next move."
                          : "Your next opportunity."}
                    </h1>
                    <p>
                      Find a role that fits your skills, interests, and the way
                      you want to work.
                    </p>
                  </div>
                  <button
                    className="primary"
                    disabled={busy || discoveryPending}
                    onClick={() =>
                      void action(
                        () =>
                          post("/discover", {
                            query: profile.preferences.keywords,
                          }),
                        "Discovery started. Follow the agents in Activity.",
                      )
                    }
                  >
                    <Search size={17} />
                    {discoveryPending
                      ? "Agents are working…"
                      : "Find internships"}
                    <ArrowUpRight size={16} />
                  </button>
                </div>
              </div>
              <div className="stats-row">
                <Stat
                  label="OPPORTUNITIES FOUND"
                  value={data.analytics.total}
                  detail="In your workspace"
                  icon={Search}
                />
                <Stat
                  label="SAVED FOR LATER"
                  value={data.analytics.shortlisted}
                  detail="On your shortlist"
                  icon={Bookmark}
                />
                <Stat
                  label="APPLICATIONS SENT"
                  value={data.analytics.submitted}
                  detail="A step closer"
                  icon={Send}
                />
                <Stat
                  label="EMPLOYER RESPONSES"
                  value={data.analytics.responses}
                  detail="Keep the conversation going"
                  icon={Inbox}
                />
              </div>
              <div className="section-heading">
                <div className="segmented">
                  <button
                    className={tab === "all" ? "selected" : ""}
                    onClick={() => setTab("all")}
                  >
                    All opportunities <span>{data.analytics.total}</span>
                  </button>
                  <button
                    className={tab === "new" ? "selected" : ""}
                    onClick={() => setTab("new")}
                  >
                    New for you
                  </button>
                </div>
                <div className="small muted">
                  <span className={"status-dot " + (pending ? "pulse" : "")} />
                  {pending
                    ? `${pending} agent tasks in progress`
                    : "Your workspace is up to date"}
                </div>
              </div>
              <div className="filterbar">
                <div className="search-input">
                  <Search size={17} />
                  <input
                    aria-label="Search opportunities"
                    placeholder="Search roles, companies, or skills…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <select
                  aria-label="Filter opportunities"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All work styles</option>
                  <option value="remote">Remote only</option>
                  <option value="eligible">Meets checked constraints</option>
                </select>
                <div className="sort-select">
                  <SlidersHorizontal size={16} />
                  <select
                    aria-label="Sort opportunities"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="fit">Best match</option>
                    <option value="deadline">Deadline soonest</option>
                    <option value="pay">Monthly pay (INR)</option>
                  </select>
                </div>
              </div>
              {listings.length ? (
                <div className="opportunities">
                  {listings.map((l: any) => (
                    <article className="opportunity" key={l.id}>
                      <div className="card-top">
                        <div
                          className={
                            "company-logo company-" + (l.company.length % 3)
                          }
                        >
                          {l.company
                            .split(" ")
                            .map((s: string) => s[0])
                            .slice(0, 2)
                            .join("")}
                        </div>
                        <span
                          className={
                            "fit-badge " +
                            (l.match.score < 65 ? "moderate" : "")
                          }
                        >
                          <span className="status-dot" />
                          {l.match.score}% match
                        </span>
                        <button
                          className={
                            "icon-button bookmark " +
                            (l.match.shortlisted ? "saved" : "")
                          }
                          aria-label={
                            l.match.shortlisted
                              ? "Remove from shortlist"
                              : "Shortlist " + l.title
                          }
                          onClick={() =>
                            void action(() =>
                              post(`/listings/${l.id}/feedback`, {
                                shortlisted: !l.match.shortlisted,
                              }),
                            )
                          }
                        >
                          <Bookmark
                            size={19}
                            fill={l.match.shortlisted ? "currentColor" : "none"}
                          />
                        </button>
                      </div>
                      <div className="company-name">
                        {l.company}
                        <span className="small muted">
                          {" "}
                          ·{" "}
                          {l.provenance === "demo"
                            ? "Demo employer"
                            : "Source verified"}
                        </span>
                      </div>
                      <h2>{l.title}</h2>
                      <div className="role-meta">
                        <span>
                          {l.workMode === "remote"
                            ? "↗ Remote"
                            : l.location || "Location unspecified"}
                        </span>
                        <span>·</span>
                        <span>
                          {l.durationMonths
                            ? `${l.durationMonths} months`
                            : "Duration unspecified"}
                        </span>
                      </div>
                      <div className="skill-tags">
                        {l.skillsMust.map((s: string) => (
                          <span
                            key={s}
                            className={
                              profile.skills.some(
                                (x: string) =>
                                  x.toLowerCase() === s.toLowerCase(),
                              )
                                ? "met"
                                : ""
                            }
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                      <p className="role-description">{l.description}</p>
                      <div className="match-reason">
                        <ShieldCheck size={15} />
                        <span>{l.match.summary}</span>
                      </div>
                      {l.match.flags.length > 0 && (
                        <div className="flags">
                          {l.match.flags.slice(0, 2).map((f: string) => (
                            <span key={f}>{f}</span>
                          ))}
                        </div>
                      )}
                      <div className="card-footer">
                        <div>
                          <strong>{pay(l)}</strong>
                          <span
                            className={
                              "deadline " +
                              (l.deadline &&
                              Date.parse(l.deadline) - Date.now() < 3 * 86400000
                                ? "soon"
                                : "")
                            }
                          >
                            <Clock size={13} />
                            {deadline(l.deadline)}
                          </span>
                        </div>
                        <button
                          className="card-cta"
                          disabled={busy || !l.match.eligible}
                          onClick={() =>
                            l.application
                              ? setReview(l.application)
                              : void prepare(l)
                          }
                        >
                          {l.application
                            ? "View application"
                            : "Prepare application"}
                          <ArrowRight size={15} />
                        </button>
                      </div>
                      <div className="card-links">
                        <button
                          onClick={() =>
                            void action(
                              () => post(`/listings/${l.id}/contacts`),
                              "Recruiting contact research queued.",
                            )
                          }
                        >
                          Find recruiting contacts
                        </button>
                        <a
                          href={safeLink(l.url)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View posting <ExternalLink size={12} />
                        </a>
                        <button
                          onClick={() =>
                            void action(
                              () => post(`/listings/${l.id}/research`),
                              "Company brief requested.",
                            )
                          }
                        >
                          Company brief
                        </button>
                        <button
                          onClick={() => {
                            const recipient = window.prompt(
                              "Published recruiting email address (review before sending):",
                            );
                            if (recipient) void prepare(l, "email", recipient);
                          }}
                        >
                          Email application
                        </button>
                        <button
                          onClick={() => {
                            const recipient = window.prompt(
                              "Published recruiting email for cold outreach (review before sending):",
                            );
                            if (recipient)
                              void prepare(l, "outreach", recipient);
                          }}
                        >
                          Cold outreach
                        </button>
                        <button
                          aria-label={"Mark " + l.title + " not relevant"}
                          onClick={() =>
                            void action(() =>
                              post(`/listings/${l.id}/feedback`, {
                                feedback: "not_relevant",
                              }),
                            )
                          }
                        >
                          Not for me
                        </button>
                      </div>
                      {data.contacts?.find(
                        (c: any) => c.listingId === l.id,
                      ) && (
                        <details className="contact-results">
                          <summary>
                            Published contacts (
                            {
                              data.contacts.find(
                                (c: any) => c.listingId === l.id,
                              ).contacts.length
                            }
                            )
                          </summary>
                          {data.contacts
                            .find((c: any) => c.listingId === l.id)
                            .contacts.map((c: any) => (
                              <div key={c.email}>
                                <a
                                  href={safeLink(c.source)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {c.email} · source
                                </a>
                                <button
                                  className="text-button"
                                  onClick={() =>
                                    void prepare(l, "outreach", c.email)
                                  }
                                >
                                  Draft outreach
                                </button>
                              </div>
                            ))}
                          <small className="muted">
                            Review the source and recipient before sending.
                          </small>
                        </details>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={Search}
                  title={
                    discoveryPending
                      ? "Your agents are looking."
                      : "A fresh start."
                  }
                  text={
                    discoveryPending
                      ? "Discovery and matching are running. New opportunities will appear here."
                      : "Set your preferences and find internships to start building your shortlist."
                  }
                  action={
                    !discoveryPending ? (
                      <button
                        className="primary"
                        onClick={() =>
                          void action(() =>
                            post("/discover", {
                              query: profile.preferences.keywords,
                            }),
                          )
                        }
                      >
                        Find internships <ArrowRight size={16} />
                      </button>
                    ) : undefined
                  }
                />
              )}
            </>
          )}
          {tab === "applied" && (
            <>
              <PageTitle
                eyebrow="EVERY STEP, IN ONE PLACE"
                title="Your applications."
                text="Review drafts, verify submissions, and keep track of what comes next."
              />
              {data.applications.length ? (
                <div className="panel application-list">
                  {data.applications.map((a: any) => (
                    <button
                      className="application-row"
                      key={a.id}
                      onClick={() => setReview(a)}
                    >
                      <div className="company-logo">{a.listing.company[0]}</div>
                      <div className="grow">
                        <h3>{a.listing.title}</h3>
                        <p>
                          {a.listing.company} ·{" "}
                          {a.route === "web"
                            ? "Website application"
                            : a.route === "outreach"
                              ? "Cold outreach"
                              : "Email application"}
                        </p>
                      </div>
                      <span className={"state state-" + a.status}>
                        {fmtStatus(a.status)}
                      </span>
                      {a.employerStatus && (
                        <span className="state response">
                          {a.employerStatus}
                        </span>
                      )}
                      <ChevronRight size={18} />
                    </button>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={Send}
                  title="Your journey starts with one application."
                  text="Prepare an opportunity from Discover. You’ll review everything before it is sent."
                />
              )}
            </>
          )}
          {tab === "responses" && (
            <>
              <PageTitle
                eyebrow="KEEP THE CONVERSATION GOING"
                title="Good things happen next."
                text="Employer messages and the actions they need from you."
              />
              {data.responses.length ? (
                <div className="panel">
                  {data.responses.map((r: any) => (
                    <div className="response-row" key={r.id}>
                      <span className="response-icon">
                        <Mail size={20} />
                      </span>
                      <div className="grow">
                        <div className="row">
                          <h3>{r.subject}</h3>
                          <span className="state response">{r.kind}</span>
                        </div>
                        <p>
                          {r.from} · {new Date(r.receivedAt).toLocaleString()}
                        </p>
                        <p className="response-text">{r.text}</p>
                        {r.suggestedAction && (
                          <p className="small">
                            <strong>Next step:</strong> {r.suggestedAction}
                          </p>
                        )}
                        {r.provenance === "demo" && (
                          <span className="demo-label">SIMULATED REPLY</span>
                        )}
                      </div>
                      <button
                        className="secondary"
                        onClick={() =>
                          setReview(
                            data.applications.find(
                              (a: any) => a.id === r.applicationId,
                            ),
                          )
                        }
                      >
                        View application
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={Inbox}
                  title="A little quiet, for now."
                  text="Replies appear here once an employer responds. Connect Gmail in settings for real messages."
                />
              )}
            </>
          )}
          {tab === "analysis" && (
            <>
              <PageTitle
                eyebrow="SEE YOUR MOMENTUM"
                title="A clearer picture."
                text="Understand your application journey and where you can grow."
              />
              <div className="stats-row">
                <Stat
                  label="DISCOVERED"
                  value={data.analytics.total}
                  detail="Verified opportunity records"
                  icon={Search}
                />
                <Stat
                  label="SHORTLISTED"
                  value={data.analytics.shortlisted}
                  detail="Saved opportunities"
                  icon={Bookmark}
                />
                <Stat
                  label="SENT"
                  value={data.analytics.submitted}
                  detail="Excludes cold outreach"
                  icon={Send}
                />
                <Stat
                  label="RESPONSES"
                  value={data.analytics.responses}
                  detail="Employer updates"
                  icon={Inbox}
                />
              </div>
              <div className="two-columns">
                <section className="panel padded">
                  <h2>Your journey so far</h2>
                  {[
                    ["Discovered", data.analytics.total],
                    ["Shortlisted", data.analytics.shortlisted],
                    ["Applications sent", data.analytics.submitted],
                    ["Responses", data.analytics.responses],
                  ].map(([label, value]) => (
                    <div className="funnel-row" key={label}>
                      <span>{label}</span>
                      <div className="bar-track">
                        <div
                          style={{
                            width: `${(Number(value) / Math.max(1, data.analytics.total)) * 100}%`,
                          }}
                        />
                      </div>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </section>
                <section className="panel padded">
                  <h2>Skills to explore</h2>
                  <p className="muted">
                    Requested skills missing from your current profile.
                  </p>
                  <div className="skill-tags">
                    {data.analytics.skillGaps.map((s: string) => (
                      <span key={s}>{s}</span>
                    ))}
                  </div>
                  {!data.analytics.skillGaps.length && (
                    <p>No skill gaps identified yet.</p>
                  )}
                </section>
              </div>
              <div className="panel padded">
                <h2>Company research</h2>
                {data.briefs.map((b: any) => (
                  <div className="brief" key={b.id}>
                    <h3>
                      {b.company} <span className="state">{b.status}</span>
                    </h3>
                    <p>
                      {typeof b.report === "string"
                        ? b.report
                        : JSON.stringify(b.report)}
                    </p>
                    {b.error && (
                      <p className="error">{JSON.stringify(b.error)}</p>
                    )}
                  </div>
                ))}
                {!data.briefs.length && (
                  <p className="muted">
                    Request a company brief from an opportunity card.
                  </p>
                )}
              </div>
            </>
          )}
          {tab === "activity" && (
            <>
              <PageTitle
                eyebrow="A WORKFLOW YOU CAN FOLLOW"
                title="Meet your momentum."
                text="See what each agent observed, decided, and completed."
              />
              <div className="agent-strip">
                {[
                  "Supervisor",
                  "Discovery",
                  "Extractor",
                  "Matcher",
                  "Mapper",
                  "Filler",
                  "Verifier",
                  "Tracker",
                ].map((s, i) => (
                  <div key={s}>
                    <span className="agent-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
              <div className="two-columns">
                <div className="panel padded">
                  <h2>Agent timeline</h2>
                  <div className="timeline">
                    {data.events.map((e: any) => (
                      <div className="timeline-item" key={e.id}>
                        <span className="timeline-dot" />
                        <div>
                          <span className="eyebrow">{e.agent}</span>
                          <p>{e.message}</p>
                          {e.details.error && (
                            <div className="error small">{e.details.error}</div>
                          )}
                          <small>{new Date(e.at).toLocaleTimeString()}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                  {!data.events.length && (
                    <p className="muted">
                      Start discovery to see the workflow here.
                    </p>
                  )}
                </div>
                <div>
                  <section className="panel padded">
                    <h2>Durable tasks</h2>
                    {data.jobs.map((j: any) => (
                      <div className="job" key={j.id}>
                        <div className="row">
                          <strong>{fmtStatus(j.kind)}</strong>
                          <span className={"state state-" + j.status}>
                            {j.status}
                          </span>
                        </div>
                        {j.last_error && (
                          <p className="error small">{j.last_error}</p>
                        )}
                      </div>
                    ))}
                  </section>
                  <section className="panel padded">
                    <h2>Audit trail</h2>
                    {data.audit.slice(0, 20).map((a: any) => (
                      <div className="job" key={a.id}>
                        <strong>{fmtStatus(a.action)}</strong>
                        <p>
                          {a.actor} · {new Date(a.at).toLocaleTimeString()}
                        </p>
                      </div>
                    ))}
                  </section>
                </div>
              </div>
            </>
          )}
          {tab === "sources" && <Sources data={data} action={action} />}{" "}
          {tab === "settings" && profile && (
            <SettingsPanel
              profile={profile}
              setProfile={setProfile}
              caps={caps}
              action={action}
            />
          )}{" "}
        </main>
        <footer className="footer">
          <span>Make your next chapter count.</span>
          <span>
            <ShieldCheck size={13} /> You review every application before
            submission.
          </span>
        </footer>
      </div>
      {notifications && (
        <div className="notifications-popover">
          <div className="row">
            <h3>Updates for you</h3>
            <button
              className="icon-button"
              aria-label="Close notifications"
              onClick={() => setNotifications(false)}
            >
              <X size={18} />
            </button>
          </div>
          {data.notifications.length ? (
            data.notifications.map((n: any) => (
              <button
                className={"notification " + (n.read ? "read" : "")}
                key={n.id}
                onClick={() =>
                  void action(() => post(`/notifications/${n.id}/read`))
                }
              >
                <strong>{n.message}</strong>
                <small>{new Date(n.createdAt).toLocaleString()}</small>
                {n.channels
                  .filter((c: any) => c.channel !== "in_app")
                  .map((c: any) => (
                    <small key={c.channel}>
                      {c.channel}: {c.status}
                    </small>
                  ))}
              </button>
            ))
          ) : (
            <p className="muted">Your updates will appear here.</p>
          )}
        </div>
      )}
      {review && (
        <Review
          application={review}
          busy={busy}
          action={action}
          onClose={() => setReview(null)}
          caps={caps}
        />
      )}
    </div>
  );
}
function Stat({ label, value, detail, icon: Icon }: any) {
  return (
    <div className="stat">
      <div className="row">
        <span>{label}</span>
        <Icon size={17} />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
function PageTitle({ eyebrow, title, text }: any) {
  return (
    <div className="page-heading">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{text}</p>
    </div>
  );
}
function Empty({ icon: Icon, title, text, action }: any) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={30} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Sources({ data, action }: any) {
  return (
    <>
      <PageTitle
        eyebrow="A WIDER VIEW"
        title="Where opportunities begin."
        text="Choose sources and control how your agents interact with them."
      />
      <form
        className="panel padded"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget,
            url = new FormData(form).get("url");
          const result = await action(
            () => post("/listings/import", { url }),
            "Posting queued for extraction and matching.",
          );
          if (result) form.reset();
        }}
      >
        <h2>Import a specific internship</h2>
        <label>
          Public internship posting URL
          <input
            name="url"
            type="url"
            required
            placeholder="https://company.com/careers/internship"
          />
        </label>
        <button
          className="secondary"
          disabled={data.capabilities.mode !== "live"}
        >
          <Plus size={15} />
          Import posting
        </button>
        <p className="small muted">
          Live mode reads the posting with TinyFish, checks its evidence, and
          adds a match to your workspace.
        </p>
      </form>
      <div className="two-columns">
        <div className="panel padded">
          <h2>Your sources</h2>
          {data.sources.map((s: any) => (
            <div className="source" key={s.id}>
              <div className="row">
                <h3>{s.name}</h3>
                <span className="state">{s.health}</span>
              </div>
              <p className="small break">{s.target}</p>
              <div className="row">
                <select
                  aria-label={"Policy for " + s.name}
                  value={s.policy}
                  onChange={(e) =>
                    void action(() =>
                      api(`/sources/${s.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ policy: e.target.value }),
                      }),
                    )
                  }
                >
                  <option value="monitor_only">Discovery only</option>
                  <option value="prepare_forms">Allow form preparation</option>
                  <option value="blocked">Blocked</option>
                </select>
                <button
                  className="secondary"
                  onClick={() =>
                    void action(
                      () => post(`/sources/${s.id}/refresh`),
                      "Source refresh queued.",
                    )
                  }
                >
                  <RefreshCw size={14} />
                  Refresh
                </button>
                {
                  <button
                    className="secondary"
                    onClick={() =>
                      void action(() =>
                        api(`/sources/${s.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            status: s.status === "paused" ? "active" : "paused",
                          }),
                        }),
                      )
                    }
                  >
                    {s.status === "paused" ? "Resume" : "Pause"}
                  </button>
                }
              </div>
              {s.error && <p className="error small">{s.error}</p>}
            </div>
          ))}
          {!data.sources.length && (
            <p className="muted">
              Add a company careers page or a search topic.
            </p>
          )}
        </div>
        <form
          className="panel padded"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget,
              f = new FormData(form);
            const r = await action(
              () =>
                post("/sources", {
                  name: f.get("name"),
                  type: f.get("type"),
                  target: f.get("target"),
                  policy: f.get("policy"),
                  schedule: f.get("schedule"),
                  createMonitor: f.get("monitor") === "on",
                }),
              "Source added.",
            );
            if (r) form.reset();
          }}
        >
          <h2>Add a source</h2>
          <label>
            Name
            <input name="name" required placeholder="Company careers" />
          </label>
          <label>
            Source type
            <select name="type">
              <option value="fetch">Public careers page</option>
              <option value="search">Search topic</option>
            </select>
          </label>
          <label>
            URL or search query
            <input
              name="target"
              required
              placeholder="https://company.com/careers"
            />
          </label>
          <label>
            Agent permissions
            <select name="policy">
              <option value="monitor_only">Discovery only</option>
              <option value="prepare_forms">Allow form preparation</option>
              <option value="blocked">Blocked</option>
            </select>
          </label>
          <label>
            Schedule (UTC cron)
            <input name="schedule" defaultValue="0 */6 * * *" />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              name="monitor"
              disabled={data.capabilities.mode === "demo"}
            />
            Create a TinyFish Monitor
          </label>
          <button className="primary">
            <Plus size={16} />
            Add source
          </button>
          <p className="small muted">
            Monitors need live credentials. Local webhook delivery needs a
            public URL and WEBHOOK_SECRET.
          </p>
        </form>
      </div>
    </>
  );
}
function SettingsPanel({ profile: p, setProfile, caps, action }: any) {
  const [inspector, setInspector] = useState<{
    url: string;
    profileId: string;
  } | null>(null);
  const update = (key: string, value: any) =>
    setProfile({ ...p, [key]: value });
  return (
    <>
      <PageTitle
        eyebrow="BUILT AROUND YOU"
        title="Your story. Your preferences."
        text="Keep your profile accurate. Agents use these facts to prepare your applications."
      />
      <div className="two-columns settings-grid">
        <form
          className="panel padded"
          onSubmit={(e) => {
            e.preventDefault();
            void action(
              () => api("/profile", { method: "PUT", body: JSON.stringify(p) }),
              "Profile saved. Matches are being updated.",
            );
          }}
        >
          <h2>Candidate profile</h2>
          <div className="form-grid">
            <label>
              Full name
              <input
                value={p.name}
                onChange={(e) => update("name", e.target.value)}
                required
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={p.email}
                onChange={(e) => update("email", e.target.value)}
                required
              />
            </label>
            <label>
              Phone
              <input
                value={p.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="+91…"
              />
            </label>
            <label>
              Headline
              <input
                value={p.headline}
                onChange={(e) => update("headline", e.target.value)}
              />
            </label>
          </div>
          <label>
            Education
            <textarea
              value={p.education}
              onChange={(e) => update("education", e.target.value)}
            />
          </label>
          <label>
            Skills (comma separated)
            <input
              value={p.skills.join(", ")}
              onChange={(e) =>
                update(
                  "skills",
                  e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
          <div className="form-grid">
            {["github", "linkedin", "portfolio"].map((key) => (
              <label key={key}>
                {key[0].toUpperCase() + key.slice(1)}
                <input
                  value={p.links[key]}
                  onChange={(e) =>
                    update("links", { ...p.links, [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
          <div className="row">
            <h3>Your projects</h3>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                update("projects", [
                  ...p.projects,
                  { name: "", description: "", skills: [], url: "" },
                ])
              }
            >
              <Plus size={14} />
              Add project
            </button>
          </div>
          {p.projects.map((project: any, i: number) => (
            <div className="project-form" key={i}>
              <input
                aria-label="Project name"
                placeholder="Project name"
                value={project.name}
                onChange={(e) =>
                  update(
                    "projects",
                    p.projects.map((x: any, j: number) =>
                      j === i ? { ...x, name: e.target.value } : x,
                    ),
                  )
                }
              />
              <textarea
                aria-label="Project description"
                placeholder="Describe what you actually built"
                value={project.description}
                onChange={(e) =>
                  update(
                    "projects",
                    p.projects.map((x: any, j: number) =>
                      j === i ? { ...x, description: e.target.value } : x,
                    ),
                  )
                }
              />
              <input
                aria-label="Project skills"
                placeholder="Skills, comma separated"
                value={project.skills.join(", ")}
                onChange={(e) =>
                  update(
                    "projects",
                    p.projects.map((x: any, j: number) =>
                      j === i
                        ? {
                            ...x,
                            skills: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          }
                        : x,
                    ),
                  )
                }
              />
            </div>
          ))}
          <h2 className="subheading">Opportunity preferences</h2>
          <label>
            Search keywords
            <input
              value={p.preferences.keywords}
              onChange={(e) =>
                update("preferences", {
                  ...p.preferences,
                  keywords: e.target.value,
                })
              }
            />
          </label>
          <div className="form-grid">
            <label>
              Location
              <input
                value={p.preferences.location}
                onChange={(e) =>
                  update("preferences", {
                    ...p.preferences,
                    location: e.target.value,
                  })
                }
              />
            </label>
            <label>
              Minimum monthly stipend (INR)
              <input
                type="number"
                min="0"
                value={p.preferences.minStipend}
                onChange={(e) =>
                  update("preferences", {
                    ...p.preferences,
                    minStipend: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Available months
              <input
                type="number"
                min="0"
                max="24"
                value={p.preferences.availableMonths}
                onChange={(e) =>
                  update("preferences", {
                    ...p.preferences,
                    availableMonths: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Graduation year
              <input
                type="number"
                value={p.preferences.graduationYear ?? ""}
                onChange={(e) =>
                  update("preferences", {
                    ...p.preferences,
                    graduationYear: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </label>
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={p.preferences.remoteOnly}
              onChange={(e) =>
                update("preferences", {
                  ...p.preferences,
                  remoteOnly: e.target.checked,
                })
              }
            />
            Remote opportunities only
          </label>
          <h2 className="subheading">Notifications</h2>
          <label className="check-label">
            <input
              type="checkbox"
              checked={p.alerts.email}
              onChange={(e) =>
                update("alerts", { ...p.alerts, email: e.target.checked })
              }
            />
            Email updates
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={p.alerts.voice}
              onChange={(e) =>
                update("alerts", { ...p.alerts, voice: e.target.checked })
              }
            />
            Phone calls for urgent updates (maximum three per day)
          </label>
          <div className="form-grid">
            <label>
              Quiet hours start
              <input
                type="number"
                min="0"
                max="23"
                value={p.alerts.quietStart}
                onChange={(e) =>
                  update("alerts", {
                    ...p.alerts,
                    quietStart: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Quiet hours end
              <input
                type="number"
                min="0"
                max="23"
                value={p.alerts.quietEnd}
                onChange={(e) =>
                  update("alerts", {
                    ...p.alerts,
                    quietEnd: Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <label>
            Timezone
            <input
              value={p.alerts.timezone}
              onChange={(e) =>
                update("alerts", { ...p.alerts, timezone: e.target.value })
              }
            />
          </label>
          <button className="primary">
            <Check size={17} />
            Save profile
          </button>
        </form>
        <div>
          <section className="panel padded">
            <h2>Your resume</h2>
            <p className="muted">
              Upload a PDF or text resume. Review extracted facts before saving
              them to your profile.
            </p>
            <label className="upload-box">
              <Upload size={24} />
              <strong>Choose your resume</strong>
              <span className="small">PDF or TXT · up to 5 MB</span>
              <input
                type="file"
                accept="application/pdf,text/plain"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const f = new FormData();
                  f.append("resume", file);
                  const r = await action(
                    () => api("/profile/resume", { method: "POST", body: f }),
                    "Resume uploaded. Review the suggested profile.",
                  );
                  if (r) setProfile(r.suggestion);
                }}
              />
            </label>
            {p.resumeId && (
              <a
                href={`/api/documents/${p.resumeId}`}
                target="_blank"
                rel="noreferrer"
                className="text-button"
              >
                Open uploaded resume <ExternalLink size={14} />
              </a>
            )}
          </section>
          <section className="panel padded">
            <h2>Connected services</h2>
            <p className="muted">
              Credentials stay on the server. Configure them in the project’s
              .env file.
            </p>
            {[
              ["TinyFish", caps.tinyfish],
              ["Gemini reasoning", caps.intelligence],
              ["Google OAuth", caps.google],
              ["Gmail mailbox", caps.gmailConnected],
              ["Email notifications", caps.email],
              ["Phone notifications", caps.voice],
            ].map(([label, enabled]) => (
              <div className="integration" key={String(label)}>
                <span>{label}</span>
                <span className={"state " + (enabled ? "connected" : "")}>
                  {enabled ? "Configured" : "Not configured"}
                </span>
              </div>
            ))}
            <button
              className="secondary wide"
              onClick={() =>
                void action(
                  () => post("/integrations/tinyfish/probe"),
                  "Live TinyFish Search and Fetch probe completed.",
                )
              }
              disabled={!caps.tinyfish}
            >
              <Radio size={16} />
              Test TinyFish connection
            </button>
            {caps.google && (
              <a
                className="button secondary wide"
                href="/api/auth/google?connect=gmail"
              >
                Connect Gmail <ArrowUpRight size={16} />
              </a>
            )}
            {caps.gmailConnected && (
              <div className="row">
                <button
                  className="secondary"
                  onClick={() =>
                    void action(
                      () => post("/inbox/poll"),
                      "Mailbox check queued.",
                    )
                  }
                >
                  Check inbox
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void action(
                      () => post("/inbox/disconnect"),
                      "Gmail disconnected.",
                    )
                  }
                >
                  Disconnect
                </button>
              </div>
            )}
            <p className="small muted">
              Runtime: {caps.mode} · Storage: {caps.storage}
            </p>
          </section>
          <section className="panel padded">
            <h2>Employer browser profiles</h2>
            <p className="muted">
              Save signed-in state for portal checks. Each profile belongs to
              your workspace.
            </p>
            {(caps.browserProfiles || []).map((p: any) => (
              <div className="integration" key={p.id}>
                <div>
                  <strong>{p.name}</strong>
                  <small className="muted">
                    {" "}
                    · {p.configured ? "Ready" : "Needs sign-in"}
                  </small>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    const url = window.prompt("Employer portal login URL:");
                    if (url)
                      void action(() =>
                        post(`/browser-profiles/${p.id}/setup`, { url }),
                      ).then((r: any) => {
                        if (r)
                          setInspector({
                            url: r.inspectorUrl,
                            profileId: p.id,
                          });
                      });
                  }}
                >
                  Sign in
                </button>
              </div>
            ))}
            <button
              className="secondary"
              disabled={caps.mode !== "live" || !caps.tinyfish}
              onClick={() => {
                const name = window.prompt("Name for this employer account:");
                if (name)
                  void action(
                    () => post("/browser-profiles", { name }),
                    "Browser profile created. Sign in to configure it.",
                  );
              }}
            >
              <Plus size={15} />
              Create browser profile
            </button>
            {inspector && (
              <div className="verification">
                <a
                  className="text-button"
                  href={safeLink(inspector.url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open sign-in browser <ExternalLink size={14} />
                </a>
                <p className="small">
                  Sign in in the browser, then save the session here.
                </p>
                <button
                  className="secondary"
                  onClick={() =>
                    void action(
                      () =>
                        post(`/browser-profiles/${inspector.profileId}/save`),
                      "Signed-in state saved.",
                    ).then((r: any) => {
                      if (r) setInspector(null);
                    })
                  }
                >
                  Save signed-in state
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
function Review({ application: a, busy, action, onClose, caps }: any) {
  const [answers, setAnswers] = useState<Record<string, string>>({}),
    [letter, setLetter] = useState(a.package?.coverLetter || ""),
    [recipient, setRecipient] = useState(a.package?.recipient || ""),
    [portal, setPortal] = useState(""),
    [profileId, setProfileId] = useState("");
  useEffect(() => {
    setAnswers({});
    setLetter(a.package?.coverLetter || "");
    setRecipient(a.package?.recipient || "");
  }, [a.id, a.package?.resumeId]);
  const ready = a.status === "awaiting_approval";
  const editable = ["needs_user_input", "awaiting_approval", "failed"].includes(
    a.status,
  );
  return (
    <div className="modal-backdrop">
      <section
        className="review-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Review application"
      >
        <header className="review-header">
          <div>
            <div className="eyebrow">YOUR APPLICATION, YOUR FINAL SAY</div>
            <h2>{a.listing?.title || "Review application"}</h2>
            <p>
              {a.listing?.company}{" "}
              <span className={"state state-" + a.status}>
                {fmtStatus(a.status)}
              </span>
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close review"
            onClick={onClose}
          >
            <X size={23} />
          </button>
        </header>
        <div className="review-body">
          {a.provenance === "demo" && (
            <div className="demo-banner">
              <span>CONTROLLED DEMO</span> This application is sent to the local
              demo employer.
            </div>
          )}
          {a.error && <div className="error">{a.error}</div>}
          <div className="review-steps">
            {[
              "mapping",
              "needs_user_input",
              "filling",
              "awaiting_approval",
              "submitted",
            ].map((s, i) => (
              <div key={s} className={a.status === s ? "current" : ""}>
                <span>{i + 1}</span>
                {["Map", "Answer", "Fill & verify", "Review", "Submit"][i]}
              </div>
            ))}
          </div>
          {!editable &&
            ![
              "submitted",
              "email_sent",
              "outreach_sent",
              "submission_uncertain",
              "discarded",
              "blocked",
            ].includes(a.status) && (
              <div className="processing">
                <LoaderCircle className="spin" />
                Agents are preparing your application. This screen updates
                automatically.
              </div>
            )}
          {!!a.gaps?.length && (
            <section className="panel padded">
              <h3>A few details only you can answer.</h3>
              <p className="muted">
                These answers will be saved for future applications. Use your
                actual experience.
              </p>
              {a.gaps.map((f: any) => (
                <label key={f.label}>
                  {f.label}
                  {f.options?.length ? (
                    <select
                      aria-label={f.label}
                      value={answers[f.label] || ""}
                      onChange={(e) =>
                        setAnswers({ ...answers, [f.label]: e.target.value })
                      }
                    >
                      <option value="">Choose an answer</option>
                      {f.options.filter(Boolean).map((v: string) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <textarea
                      aria-label={f.label}
                      rows={3}
                      value={answers[f.label] || ""}
                      onChange={(e) =>
                        setAnswers({ ...answers, [f.label]: e.target.value })
                      }
                    />
                  )}
                </label>
              ))}
            </section>
          )}
          {a.verification && (
            <section className="verification">
              <div className="row">
                <ShieldCheck size={21} />
                <h3>
                  {a.verification.errors.length
                    ? "Review needs attention"
                    : "Independent verification completed"}
                </h3>
              </div>
              {a.verification.errors.map((s: string) => (
                <p className="error" key={s}>
                  {s}
                </p>
              ))}
              {a.verification.warnings.map((s: string) => (
                <p className="small muted" key={s}>
                  {s}
                </p>
              ))}
              {!a.verification.errors.length && (
                <p className="small">
                  Required fields and resume upload were checked against browser
                  read-back.
                </p>
              )}
            </section>
          )}
          {!!a.answers && (
            <section className="panel padded">
              <h3>Application answers</h3>
              <div className="answer-table">
                {Object.entries(a.answers).map(([label, answer]: any) => (
                  <div key={label}>
                    <strong>{label}</strong>
                    {editable &&
                    a.formMap.fields.find((f: any) => f.label === label)
                      ?.type !== "file" ? (
                      <input
                        aria-label={"Edit " + label}
                        value={answers[label] ?? answer.value}
                        onChange={(e) =>
                          setAnswers({ ...answers, [label]: e.target.value })
                        }
                      />
                    ) : (
                      <span>
                        {a.formMap?.fields.find((f: any) => f.label === label)
                          ?.type === "file"
                          ? "Tailored PDF resume"
                          : answer.value}
                      </span>
                    )}
                    <small>
                      {answer.source.startsWith("profile.")
                        ? "From your profile"
                        : answer.source.startsWith("package.")
                          ? "Generated from your profile"
                          : "Provided by you"}
                    </small>
                  </div>
                ))}
              </div>
            </section>
          )}
          {a.package && (
            <section className="panel padded">
              <div className="row">
                <h3>Application documents</h3>
                {a.package.resumeId && (
                  <a
                    className="text-button"
                    href={`/api/documents/${a.package.resumeId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FileText size={15} />
                    Open tailored resume
                  </a>
                )}
                {a.package.coverLetterId && (
                  <a
                    className="text-button"
                    href={`/api/documents/${a.package.coverLetterId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open cover letter PDF <ExternalLink size={14} />
                  </a>
                )}
              </div>
              {a.route !== "web" && (
                <label>
                  Reviewed recipient
                  <input
                    type="email"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    disabled={!editable}
                  />
                </label>
              )}
              <label>
                Cover letter
                <textarea
                  rows={10}
                  value={letter}
                  onChange={(e) => setLetter(e.target.value)}
                  disabled={!editable}
                />
              </label>
            </section>
          )}
          {editable && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void action(
                  () =>
                    api(`/applications/${a.id}/answers`, {
                      method: "PUT",
                      body: JSON.stringify({
                        answers,
                        coverLetter: letter,
                        ...(a.route !== "web" ? { recipient } : {}),
                      }),
                    }),
                  "Answers saved; verification is running.",
                ).then((r: any) => {
                  if (r) setAnswers({});
                })
              }
            >
              <RefreshCw size={16} />
              Save changes and verify
            </button>
          )}
          {a.screenshotId && (
            <section className="panel padded">
              <h3>Browser review screenshot</h3>
              <img
                className="review-screenshot"
                src={`/api/documents/${a.screenshotId}`}
                alt="Actual filled application form before submission"
              />
            </section>
          )}
          {a.streamingUrl &&
            /^https:\/\//.test(a.streamingUrl) &&
            a.status === "mapping" && (
              <iframe
                title="TinyFish live form mapping"
                className="browser-preview"
                src={a.streamingUrl}
              />
            )}
          {a.receipt && (
            <section className="verification">
              <h3>
                {a.route === "outreach"
                  ? "Outreach record"
                  : "Submission evidence"}
              </h3>
              <p className="break">
                {a.receipt.text || `Message reference: ${a.receipt.messageId}`}
              </p>
              {a.receipt.simulated && (
                <p className="small">Simulated delivery in demo mode.</p>
              )}
              {a.confirmationId && (
                <a
                  className="text-button"
                  target="_blank"
                  rel="noreferrer"
                  href={`/api/documents/${a.confirmationId}`}
                >
                  View confirmation screenshot <ExternalLink size={14} />
                </a>
              )}
            </section>
          )}
          {a.submittedAt && (
            <section className="panel padded">
              <h3>Track the next step</h3>
              <p>
                {a.employerStatus
                  ? `Employer status: ${a.employerStatus}`
                  : "Awaiting employer response."}
              </p>
              {caps.mode === "live" ? (
                <>
                  <label>
                    Application-status URL
                    <input
                      value={portal}
                      onChange={(e) => setPortal(e.target.value)}
                      placeholder="https://employer.example/my-applications"
                    />
                  </label>
                  <label>
                    Employer browser profile (optional)
                    <select
                      value={profileId}
                      onChange={(e) => setProfileId(e.target.value)}
                    >
                      <option value="">Public page — no login</option>
                      {(caps.browserProfiles || [])
                        .filter((p: any) => p.configured)
                        .map((p: any) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    className="secondary"
                    onClick={() =>
                      void action(async () => {
                        await api(`/applications/${a.id}/portal`, {
                          method: "PUT",
                          body: JSON.stringify({
                            url: portal,
                            profileId: profileId || undefined,
                          }),
                        });
                        return post(`/applications/${a.id}/check`);
                      }, "Portal check queued.")
                    }
                  >
                    Check employer portal
                  </button>
                </>
              ) : (
                <button
                  className="secondary"
                  onClick={() =>
                    void action(
                      () => post(`/applications/${a.id}/simulate-reply`),
                      "Simulated employer reply recorded.",
                    )
                  }
                >
                  Simulate demo reply
                </button>
              )}
            </section>
          )}
          {["failed", "blocked"].includes(a.status) && (
            <button
              className="secondary"
              onClick={() =>
                void action(
                  () => post(`/applications/${a.id}/retry`),
                  "Preparation retry queued.",
                )
              }
            >
              Retry preparation
            </button>
          )}
          {a.status === "submission_uncertain" && (
            <section className="panel padded">
              <h3>Confirm the outcome before retrying.</h3>
              <p className="muted">
                Check the employer portal or receipt email. Record what you
                observed.
              </p>
              <button
                className="secondary"
                onClick={() => {
                  const evidence = window.prompt(
                    "Receipt or portal evidence (at least 10 characters):",
                  );
                  if (evidence)
                    void action(() =>
                      post(`/applications/${a.id}/reconcile`, {
                        outcome: "submitted",
                        evidence,
                      }),
                    );
                }}
              >
                Record confirmed submission
              </button>
              <button
                className="text-button"
                onClick={() => {
                  const evidence = window.prompt(
                    "Explain how you verified that no application was submitted:",
                  );
                  if (evidence)
                    void action(() =>
                      post(`/applications/${a.id}/reconcile`, {
                        outcome: "not_submitted",
                        evidence,
                      }),
                    );
                }}
              >
                Record not submitted
              </button>
            </section>
          )}
        </div>
        <footer className="review-footer">
          {ready && a.session && (
            <button
              className="text-button"
              onClick={() =>
                void action(
                  () => post(`/applications/${a.id}/release-session`),
                  "Browser session released. Approved answers will be replayed when you submit.",
                )
              }
            >
              Release browser session
            </button>
          )}
          <span>
            <ShieldCheck size={16} />
            {ready
              ? "Ready for your final review"
              : "Every action is recorded in your audit trail"}
          </span>
          <div className="row">
            {![
              "submitting",
              "submitted",
              "email_sent",
              "outreach_sent",
            ].includes(a.status) && (
              <button
                className="text-button danger"
                disabled={busy}
                onClick={() =>
                  void action(
                    () => post(`/applications/${a.id}/discard`),
                    "Application discarded.",
                  )
                }
              >
                Discard
              </button>
            )}
            <button className="secondary" onClick={onClose}>
              Close
            </button>
            {ready && (
              <button
                className="primary"
                disabled={
                  busy ||
                  Object.keys(answers).length > 0 ||
                  letter !== (a.package?.coverLetter || "") ||
                  recipient !== (a.package?.recipient || "") ||
                  !!a.verification?.errors.length
                }
                onClick={() =>
                  void action(
                    () =>
                      post(`/applications/${a.id}/approve`, {
                        packageHash: a.packageHash,
                      }),
                    "Approved. Submission is running.",
                  )
                }
              >
                <Send size={16} />
                {a.route === "web" ? "Approve & submit" : "Approve & send"}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
