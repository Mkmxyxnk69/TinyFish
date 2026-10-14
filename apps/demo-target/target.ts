import type { Express } from "express";
import multer from "multer";
import { randomBytes } from "node:crypto";
import { config } from "../../packages/core/config.js";
import { get, put, db, now, enqueue } from "../../packages/core/db.js";
import type { Listing } from "../../packages/core/schemas.js";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function demoListings(): Array<Listing & { id: string }> {
  const roles = [
    {
      id: "demo-backend",
      title: "Backend Engineering Intern",
      company: "Acme Labs",
      skills: ["Python", "FastAPI", "SQL"],
      amount: 24000,
      days: 5,
      mode: "remote",
    },
    {
      id: "demo-frontend",
      title: "Frontend Engineering Intern",
      company: "Studio North",
      skills: ["React", "TypeScript", "CSS"],
      amount: 18000,
      days: 3,
      mode: "remote",
    },
    {
      id: "demo-data",
      title: "Data Science Intern",
      company: "Orbit Analytics",
      skills: ["Python", "SQL", "Pandas"],
      amount: 22000,
      days: 9,
      mode: "hybrid",
    },
    {
      id: "demo-platform",
      title: "Platform Engineering Intern",
      company: "Acme Labs",
      skills: ["Docker", "Linux", "Python"],
      amount: 30000,
      days: 2,
      mode: "onsite",
    },
    {
      id: "demo-design",
      title: "Product Design Intern",
      company: "Studio North",
      skills: ["Figma", "Research", "Prototyping"],
      amount: 16000,
      days: 12,
      mode: "remote",
    },
    {
      id: "demo-ml",
      title: "Machine Learning Intern",
      company: "Orbit Analytics",
      skills: ["Python", "PyTorch", "SQL"],
      amount: 28000,
      days: 7,
      mode: "remote",
    },
  ];
  return roles.map((r) => {
    const deadline = new Date(Date.now() + r.days * 86400000).toISOString();
    const rawText = `${r.title}\nCompany: ${r.company}\nLocation: India\nWork mode: ${r.mode}\nMonthly stipend: INR ${r.amount}\nDeadline: ${deadline}\nDuration: 3 months\nRequired skills: ${r.skills.join(", ")}\nEligibility: Current university students\nBuild practical tools with our engineering team. Mentorship and a scoped internship project are included. This is a controlled demonstration listing.`;
    return {
      id: r.id,
      title: r.title,
      company: r.company,
      url: `${config.workerUrl}/demo/listing/${r.id}`,
      applyUrl: `${config.workerUrl}/demo/apply/${r.id}`,
      description:
        "Build practical tools with a small team. Get mentorship and own a scoped internship project.",
      location: "India",
      workMode: r.mode as any,
      stipendAmount: r.amount,
      currency: "INR",
      paymentPeriod: "month",
      deadline,
      durationMonths: 3,
      skillsMust: r.skills,
      skillsNice: [],
      eligibility: "Current university students",
      evidence: {
        title: r.title,
        company: r.company,
        location: "Location: India",
        stipendAmount: `Monthly stipend: INR ${r.amount}`,
        currency: "INR",
        deadline: `Deadline: ${deadline}`,
        durationMonths: "Duration: 3 months",
        eligibility: "Current university students",
        skillsMust: `Required skills: ${r.skills.join(", ")}`,
      },
      rawText,
      provenance: "demo",
      status: "open",
    };
  });
}
export function createDemoNonce(applicationId: string, userId: string) {
  return put("demo_nonce", applicationId, userId, {
    token: randomBytes(24).toString("hex"),
  });
}
export function registerDemo(app: Express) {
  app.get("/demo/careers", (_req, res) =>
    res.type("html").send(
      `<h1>Acme Careers — controlled demonstration</h1>${demoListings()
        .map(
          (l) =>
            `<p><a href="/demo/listing/${l.id}">${escape(l.title)} — ${escape(l.company)}</a></p>`,
        )
        .join("")}`,
    ),
  );
  app.get("/demo/listing/:id", (req, res) => {
    const listing =
      get("listing", String(req.params.id)) ||
      demoListings().find((l) => l.id === req.params.id);
    if (!listing) return res.status(404).send("Not found");
    res
      .type("html")
      .send(
        `<h1>${escape(listing.title)}</h1><pre>${escape(listing.rawText)}</pre><a href="/demo/apply/${listing.id}">Apply</a>`,
      );
  });
  app.get("/demo/apply/:id", (req, res) => {
    const applicationId = String(req.query.application || "").replace(
        /[^a-zA-Z0-9-]/g,
        "",
      ),
      token = String(req.query.token || "").replace(/[^a-f0-9]/g, "");
    res
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Acme Careers · Application</title><style>body{font:16px system-ui;background:#f6f8f7;color:#20352e;max-width:700px;margin:45px auto}form{background:white;border:1px solid #d8e3dc;padding:32px;border-radius:20px}label{display:block;font-weight:600;margin:18px 0 7px}input,select,textarea{box-sizing:border-box;width:100%;padding:12px;border:1px solid #cbd8d0;border-radius:8px;font:inherit}button{margin-top:24px;background:#21664b;color:white;border:0;padding:13px 24px;border-radius:8px;font:inherit}h1{font-size:30px}.hidden{display:none}small{color:#687e73}</style></head><body><small>CONTROLLED DEMO · NO REAL EMPLOYER</small><h1>Build something meaningful.</h1><p>Engineering internship application</p><form id="application"><section id="step-one"><h2>01 · About you</h2><label for="name">Full name</label><input id="name" name="name" required><label for="email">Email</label><input id="email" name="email" type="email" required><label for="phone">Phone</label><input id="phone" name="phone" type="tel"><label for="github">GitHub</label><input id="github" name="github" type="url"><label for="months">Availability (months)</label><select id="months" name="months" required><option value="">Choose duration</option><option value="3">3 months</option><option value="6">6 months</option></select><label for="resume">Resume</label><input id="resume" name="resume" type="file" accept="application/pdf" required><button type="button" id="next">Next</button></section><section id="step-two" class="hidden"><h2>02 · Your motivation</h2><label for="motivation">Why are you interested in this internship?</label><textarea id="motivation" name="motivation" rows="5" required></textarea><fieldset><legend>Are you currently a university student?</legend><label for="student-yes">Yes</label><input id="student-yes" name="student" type="radio" value="Yes" required><label for="student-no">No</label><input id="student-no" name="student" type="radio" value="No"></fieldset><button type="submit">Submit application</button></section><p id="error" role="alert"></p></form><script>document.getElementById('next').onclick=()=>{document.getElementById('step-one').classList.add('hidden');document.getElementById('step-two').classList.remove('hidden')};document.getElementById('application').onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.target);f.set('applicationId',${JSON.stringify(applicationId)});f.set('token',${JSON.stringify(token)});const response=await fetch('/demo/submit',{method:'POST',body:f});const data=await response.json();if(!response.ok){document.getElementById('error').textContent=data.error;return}document.body.innerHTML='<h1>Application received</h1><p>Thank you for applying.</p><p>Application reference: '+data.reference+'</p><small>This submission was recorded by the controlled demo employer.</small>'};</script></body></html>`,
      );
  });
  app.post(
    "/demo/submit",
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }).single("resume"),
    (req, res) => {
      const a = get("application", req.body.applicationId);
      if (
        !a ||
        (a.provenance !== "demo" && !a.controlledTarget) ||
        get("demo_nonce", a.id, a.userId)?.token !== req.body.token
      )
        return res
          .status(403)
          .json({ error: "Valid controlled-demo application token required" });
      if (a.status !== "submitting")
        return res
          .status(409)
          .json({ error: "Application is not approved for submission" });
      const existing = db
        .prepare("SELECT * FROM receipts WHERE application_id=?")
        .get(a.id) as any;
      if (existing) return res.json({ reference: existing.reference });
      if (
        !req.body.name ||
        !req.body.email ||
        !req.body.motivation ||
        !req.body.student ||
        !req.file
      )
        return res
          .status(400)
          .json({ error: "Required fields and resume are missing" });
      const reference = `ACME-${a.id.slice(0, 8).toUpperCase()}`;
      db.prepare(
        "INSERT INTO receipts(application_id,reference,data) VALUES(?,?,?)",
      ).run(
        a.id,
        reference,
        JSON.stringify({
          name: req.body.name,
          email: req.body.email,
          filename: req.file.originalname,
          bytes: req.file.size,
          at: now(),
        }),
      );
      enqueue(a.userId, "demo_reply", { applicationId: a.id }, 2000);
      res.json({ reference });
    },
  );
}
