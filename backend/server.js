const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 4000;

// ── ENV VALIDATION ──────────────────────────────────────────────────────────
// These MUST be set as environment variables in Render.
// Never hardcode secrets in source code.
const JWT_SECRET    = process.env.JWT_SECRET;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY; // service_role key, NOT anon

if (!JWT_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌  Missing required environment variables: JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── CORS ─────────────────────────────────────────────────────────────────────
// FIX: restrict to your actual Vercel frontend URL only.
// Set FRONTEND_URL in Render env vars, e.g. https://pulse-app.vercel.app
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. Render health checks, curl)
    if (!origin) return callback(null, true);
    if (origin === FRONTEND_URL) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json());

// ── In-memory supervisors ───────────────────────────────────────────────────
// To add/change users, update these values and redeploy.
// Passwords are hashed — never store plain text.
const supervisors = [
  { id: "1", name: "Alfredo", email: "alfredo@pulse.com", password: bcrypt.hashSync("pulse123", 10), role: "supervisor" },
  { id: "2", name: "Admin",   email: "admin@pulse.com",   password: bcrypt.hashSync("admin123", 10), role: "admin"      },
];

// ── Auth middleware ─────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
};

// ── AUTH ────────────────────────────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = supervisors.find(u => u.email === email);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get("/api/auth/me", auth, (req, res) => res.json(req.user));

// ── AGENTS ──────────────────────────────────────────────────────────────────
app.get("/api/agents", auth, async (req, res) => {
  const { data, error } = await supabase.from("agents").select("*").order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/agents", auth, async (req, res) => {
  const { data, error } = await supabase.from("agents").insert([req.body]).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

app.put("/api/agents/:id", auth, async (req, res) => {
  const { data, error } = await supabase.from("agents").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete("/api/agents/:id", auth, async (req, res) => {
  const { error } = await supabase.from("agents").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: "Agent deleted" });
});

// ── COACHINGS ───────────────────────────────────────────────────────────────
app.get("/api/coachings", auth, async (req, res) => {
  const { agent_id } = req.query;
  let query = supabase.from("coachings").select("*, agents(name, employee_id, team)").order("coaching_date", { ascending: false });
  if (agent_id) query = query.eq("agent_id", agent_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/coachings/:id", auth, async (req, res) => {
  const { data, error } = await supabase.from("coachings").select("*, agents(name, employee_id, team)").eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

app.post("/api/coachings", auth, async (req, res) => {
  const payload = { ...req.body, supervisor_name: req.user.name };
  const { data, error } = await supabase.from("coachings").insert([payload]).select("*, agents(name, employee_id)").single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

app.put("/api/coachings/:id", auth, async (req, res) => {
  const { data, error } = await supabase.from("coachings").update(req.body).eq("id", req.params.id).select("*, agents(name, employee_id)").single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete("/api/coachings/:id", auth, async (req, res) => {
  const { error } = await supabase.from("coachings").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: "Coaching deleted" });
});

// ── DASHBOARD STATS ─────────────────────────────────────────────────────────
app.get("/api/stats", auth, async (req, res) => {
  const { data: coachings, error } = await supabase.from("coachings").select("*, agents(name, employee_id)");
  if (error) return res.status(500).json({ error: error.message });

  const { data: agents } = await supabase.from("agents").select("id, name, employee_id, status");

  const avg = (arr, key) => {
    const vals = arr.map(c => c[key]).filter(v => v !== null && v !== undefined);
    return vals.length ? (vals.reduce((a, b) => a + Number(b), 0) / vals.length).toFixed(1) : null;
  };

  const agentStats = agents?.map(agent => {
    const ac = coachings.filter(c => c.agent_id === agent.id);
    return {
      agent,
      total_coachings: ac.length,
      avg_hold:         avg(ac, "hold_procedure"),
      avg_closing:      avg(ac, "closing_call_wrap"),
      avg_verification: avg(ac, "verification_auth"),
      avg_aht:          avg(ac, "aht"),
      avg_conformance:  avg(ac, "conformance"),
      avg_adherence:    avg(ac, "adherence"),
      avg_nps:          avg(ac, "nps"),
      avg_csat:         avg(ac, "csat"),
      avg_fcr:          avg(ac, "fcr_7days"),
    };
  });

  const team = {
    total_coachings: coachings.length,
    open:            coachings.filter(c => c.status === "open").length,
    in_progress:     coachings.filter(c => c.status === "in_progress").length,
    closed:          coachings.filter(c => c.status === "closed").length,
    avg_hold:        avg(coachings, "hold_procedure"),
    avg_closing:     avg(coachings, "closing_call_wrap"),
    avg_verification:avg(coachings, "verification_auth"),
    avg_aht:         avg(coachings, "aht"),
    avg_conformance: avg(coachings, "conformance"),
    avg_adherence:   avg(coachings, "adherence"),
    avg_nps:         avg(coachings, "nps"),
    avg_csat:        avg(coachings, "csat"),
    avg_fcr:         avg(coachings, "fcr_7days"),
  };

  res.json({ team, agentStats, totalAgents: agents?.length || 0 });
});

// ── EXPORT PDF ──────────────────────────────────────────────────────────────
app.get("/api/export/pdf/:agentId", auth, async (req, res) => {
  const { data: agent }     = await supabase.from("agents").select("*").eq("id", req.params.agentId).single();
  const { data: coachings } = await supabase.from("coachings").select("*").eq("agent_id", req.params.agentId).order("coaching_date", { ascending: false });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=coaching-${agent?.employee_id || "agent"}.pdf`);

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  doc.fontSize(20).fillColor("#f5a623").text("PULSE — Coaching Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(12).fillColor("#333").text(`Agent: ${agent?.name}  |  ID: ${agent?.employee_id}  |  Team: ${agent?.team}`);
  doc.text(`Generated: ${new Date().toLocaleDateString()}  |  Supervisor: ${req.user.name}`);
  doc.moveDown();

  coachings?.forEach((c, i) => {
    doc.fontSize(11).fillColor("#000").text(`Coaching #${i + 1} — ${c.coaching_date}`, { underline: true });
    doc.fontSize(10).fillColor("#444");
    doc.text(`Call ID: ${c.call_id || "N/A"}  |  Status: ${c.status}`);
    doc.text(`Hold: ${c.hold_procedure ?? "—"}/5  |  Closing: ${c.closing_call_wrap ?? "—"}/5  |  Verification: ${c.verification_auth ?? "—"}/5  |  AHT: ${c.aht ?? "—"}s`);
    doc.text(`Conformance: ${c.conformance ?? "—"}%  |  Adherence: ${c.adherence ?? "—"}%  |  NPS: ${c.nps ?? "—"}  |  CSAT: ${c.csat ?? "—"}%  |  FCR 7d: ${c.fcr_7days ?? "—"}%`);
    if (c.behavior_observed) doc.text(`Behavior: ${c.behavior_observed}`);
    if (c.action_plan)       doc.text(`Action Plan: ${c.action_plan}`);
    doc.moveDown(0.5);
  });

  doc.end();
});

// ── EXPORT EXCEL ────────────────────────────────────────────────────────────
app.get("/api/export/excel", auth, async (req, res) => {
  const { data: coachings } = await supabase.from("coachings").select("*, agents(name, employee_id, team)").order("coaching_date", { ascending: false });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Coachings");

  ws.columns = [
    { header: "Date",               key: "coaching_date",    width: 14 },
    { header: "Agent",              key: "agent_name",       width: 20 },
    { header: "Employee ID",        key: "employee_id",      width: 14 },
    { header: "Team",               key: "team",             width: 18 },
    { header: "Supervisor",         key: "supervisor_name",  width: 16 },
    { header: "Call ID",            key: "call_id",          width: 14 },
    { header: "Hold (1-5)",         key: "hold_procedure",   width: 12 },
    { header: "Closing (1-5)",      key: "closing_call_wrap",width: 14 },
    { header: "Verification (1-5)", key: "verification_auth",width: 18 },
    { header: "AHT (sec)",          key: "aht",              width: 12 },
    { header: "Conformance %",      key: "conformance",      width: 16 },
    { header: "Adherence %",        key: "adherence",        width: 14 },
    { header: "NPS",                key: "nps",              width: 10 },
    { header: "CSAT %",             key: "csat",             width: 12 },
    { header: "FCR 7d %",           key: "fcr_7days",        width: 12 },
    { header: "Status",             key: "status",           width: 12 },
    { header: "Behavior Observed",  key: "behavior_observed",width: 30 },
    { header: "Action Plan",        key: "action_plan",      width: 30 },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5A623" } };

  coachings?.forEach(c => {
    ws.addRow({
      ...c,
      agent_name:  c.agents?.name,
      employee_id: c.agents?.employee_id,
      team:        c.agents?.team,
    });
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=pulse-coachings.xlsx");
  await wb.xlsx.write(res);
  res.end();
});

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.post("/api/ai/coaching", auth, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await aiRes.json();
    const text = data.content?.find(c => c.type === "text")?.text || "{}";
    try {
      res.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
    } catch {
      res.status(500).json({ error: "Invalid JSON from AI" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/health", (_, res) => res.json({ status: "ok", app: "PULSE" }));

app.listen(PORT, () => console.log(`✅  PULSE API running on port ${PORT}`));