"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const API_BASE = "https://ugf-backend-production.up.railway.app";

type Step = "verify" | "id-fallback" | "not-active" | "not-found" | "assessment" | "generating" | "plan";

interface MemberInfo {
  firstName: string;
  lastName: string;
  email: string;
}

interface Assessment {
  age: string;
  location: string;
  fitnessLevel: string;
  goals: string[];
  daysPerWeek: string;
  preferredTime: string;
  currentActivity: string;
  injuries: string;
  additionalNotes: string;
}

const GOALS = ["Weight Loss", "Build Muscle", "Improve Endurance", "Increase Flexibility", "General Health"];
const DAYS = ["2", "3", "4", "5", "6"];
const TIMES = ["Morning", "Afternoon", "Evening", "Flexible"];
const ACTIVITY_LEVELS = ["Sedentary", "Lightly Active", "Moderately Active", "Very Active"];

function StepIndicator({ current }: { current: number }) {
  const steps = ["Verify Identity", "Your Assessment", "Your Plan"];
  return (
    <div className="flex items-center justify-center gap-2 mb-10">
      {steps.map((label, i) => {
        const num = i + 1;
        const active = num === current;
        const done = num < current;
        return (
          <div key={label} className="flex items-center gap-2">
            <div className="flex flex-col items-center gap-1.5">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm transition-all ${
                done ? "bg-orange-500 text-white" : active ? "bg-orange-500 text-white ring-4 ring-orange-500/30" : "bg-zinc-800 text-zinc-500 border border-zinc-700"
              }`}>
                {done ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                ) : num}
              </div>
              <span className={`text-xs font-medium hidden sm:block ${active ? "text-orange-400" : done ? "text-zinc-400" : "text-zinc-600"}`}>
                {label}
              </span>
            </div>
            {i < steps.length - 1 && <div className={`w-10 h-px mb-4 ${done ? "bg-orange-500" : "bg-zinc-700"}`} />}
          </div>
        );
      })}
    </div>
  );
}

function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-4 py-2.5 rounded-xl text-sm font-semibold border transition-all ${
        selected ? "bg-orange-500 border-orange-500 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-orange-500/50 hover:text-white"
      }`}>
      {children}
    </button>
  );
}

function inlineBold(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  if (parts.length === 1) return text;
  return <>{parts.map((p, i) => i % 2 === 1 ? <strong key={i} className="text-white font-semibold">{p}</strong> : p)}</>;
}

function renderPlan(text: string) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let tableRows: string[][] = [];
  let inTable = false;
  let i = 0;

  const flushTable = () => {
    if (!tableRows.length) return;
    const [header, ...rows] = tableRows;
    out.push(
      <div key={`t${i}`} className="overflow-x-auto my-4">
        <table className="w-full text-sm border-collapse">
          <thead><tr>{header.map((h, ci) => <th key={ci} className="text-left py-2 px-3 bg-zinc-800 text-orange-400 font-semibold border border-zinc-700">{h}</th>)}</tr></thead>
          <tbody>{rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} className="py-2 px-3 text-zinc-300 border border-zinc-700 align-top">{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    tableRows = [];
    inTable = false;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("|")) {
      if (/^\|[-| ]+\|$/.test(line)) { i++; continue; }
      inTable = true;
      tableRows.push(line.split("|").filter(c => c.trim()).map(c => c.trim()));
      i++; continue;
    }
    if (inTable) flushTable();

    if (line.startsWith("## "))
      out.push(<h2 key={i} className="font-montserrat font-black text-xl sm:text-2xl text-white mt-8 mb-3 pb-2 border-b border-zinc-800">{line.slice(3)}</h2>);
    else if (line.startsWith("### "))
      out.push(<h3 key={i} className="font-bold text-orange-400 text-base mt-5 mb-2">{line.slice(4)}</h3>);
    else if (line.startsWith("---"))
      out.push(<hr key={i} className="border-zinc-800 my-6" />);
    else if (line.startsWith("- ") || line.startsWith("* "))
      out.push(<li key={i} className="text-zinc-300 ml-5 my-1 list-disc leading-relaxed">{inlineBold(line.slice(2))}</li>);
    else if (line.trim() === "")
      out.push(<div key={i} className="h-1" />);
    else
      out.push(<p key={i} className="text-zinc-300 leading-relaxed my-1">{inlineBold(line)}</p>);
    i++;
  }
  if (inTable) flushTable();
  return out;
}

export default function FitnessAssessment() {
  const [step, setStep] = useState<Step>("verify");
  const [member, setMember] = useState<MemberInfo>({ firstName: "", lastName: "", email: "" });
  const [memberId, setMemberId] = useState("");
  const [assessment, setAssessment] = useState<Assessment>({
    age: "", location: "", fitnessLevel: "", goals: [],
    daysPerWeek: "", preferredTime: "", currentActivity: "", injuries: "", additionalNotes: "",
  });
  const [plan, setPlan] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const stepNum = step === "verify" || step === "id-fallback" ? 1 : step === "assessment" ? 2 : 3;

  const inputCls = "w-full bg-zinc-900 border border-zinc-700 focus:border-orange-500 focus:outline-none rounded-xl px-4 py-3 text-white placeholder-zinc-500 transition-colors";
  const labelCls = "block text-sm font-semibold text-zinc-300 mb-1.5";

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/verify-member`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName: member.firstName, lastName: member.lastName }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Server error ${res.status}: ${text.slice(0, 120)}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.found) setStep("id-fallback");
      else if (!data.active) setStep("not-active");
      else setStep("assessment");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to verify membership right now. Please try again.");
    }
    finally { setLoading(false); }
  }

  async function handleVerifyById(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/verify-member-by-id`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.found) setStep("not-found");
      else if (!data.active) setStep("not-active");
      else setStep("assessment");
    } catch { setError("Unable to verify membership right now. Please try again."); }
    finally { setLoading(false); }
  }

  async function handleSubmitAssessment(e: React.FormEvent) {
    e.preventDefault();
    if (!assessment.goals.length) { setError("Please select at least one goal."); return; }
    setError(""); setStep("generating");
    try {
      const res = await fetch(`${API_BASE}/generate-workout`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assessment: { name: `${member.firstName} ${member.lastName}`, ...assessment, goals: assessment.goals.join(", ") },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPlan(data.plan); setStep("plan");
    } catch { setError("Something went wrong generating your plan. Please try again."); setStep("assessment"); }
  }

  function toggleGoal(goal: string) {
    setAssessment(p => ({ ...p, goals: p.goals.includes(goal) ? p.goals.filter(g => g !== goal) : [...p.goals, goal] }));
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      <Navbar />
      <div className="pt-28 pb-20 px-4 sm:px-6 max-w-2xl mx-auto">

        <div className="text-center mb-10">
          <p className="text-orange-500 font-semibold text-sm uppercase tracking-widest mb-3">Active Members Only</p>
          <h1 className="font-montserrat font-black text-3xl sm:text-4xl text-white mb-3">Fitness Assessment</h1>
          <p className="text-zinc-400">Get a personalized workout plan built around your goals, schedule, and fitness level.</p>
        </div>

        {["verify","id-fallback","assessment","generating","plan"].includes(step) && <StepIndicator current={stepNum} />}

        {/* ── STEP 1: Verify by name + email ── */}
        {step === "verify" && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-7 sm:p-9">
            <h2 className="font-montserrat font-black text-xl text-white mb-1">Confirm Your Membership</h2>
            <p className="text-zinc-400 text-sm mb-6">We&apos;ll check your active membership using the name on your UGF account.</p>
            <form onSubmit={handleVerify} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>First Name</label>
                  <input required className={inputCls} placeholder="Jane" value={member.firstName}
                    onChange={e => setMember(p => ({ ...p, firstName: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>Last Name</label>
                  <input required className={inputCls} placeholder="Smith" value={member.lastName}
                    onChange={e => setMember(p => ({ ...p, lastName: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Email Address</label>
                <input required type="email" className={inputCls} placeholder="jane@example.com" value={member.email}
                  onChange={e => setMember(p => ({ ...p, email: e.target.value }))} />
              </div>
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <button type="submit" disabled={loading}
                className="w-full bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white font-montserrat font-bold py-3.5 rounded-xl transition-all">
                {loading ? "Checking membership…" : "Verify Membership"}
              </button>
            </form>
          </div>
        )}

        {/* ── STEP 1b: Member ID fallback ── */}
        {step === "id-fallback" && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-7 sm:p-9">
            <h2 className="font-montserrat font-black text-xl text-white mb-1">We Couldn&apos;t Find That Account</h2>
            <p className="text-zinc-400 text-sm mb-6">
              No membership found under that name. Try your member ID instead — you&apos;ll find it on your membership card or in the UGF app.
            </p>
            <form onSubmit={handleVerifyById} className="space-y-4">
              <div>
                <label className={labelCls}>Member ID</label>
                <input required className={inputCls} placeholder="e.g. 10482" value={memberId}
                  onChange={e => setMemberId(e.target.value)} />
              </div>
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <button type="submit" disabled={loading}
                className="w-full bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white font-montserrat font-bold py-3.5 rounded-xl transition-all">
                {loading ? "Checking…" : "Verify with Member ID"}
              </button>
              <button type="button" onClick={() => { setError(""); setStep("verify"); }}
                className="w-full border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-white font-semibold py-3 rounded-xl transition-all text-sm">
                ← Try a different name
              </button>
            </form>
          </div>
        )}

        {/* ── Not active ── */}
        {step === "not-active" && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-9 text-center">
            <div className="w-14 h-14 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-5">
              <svg className="w-7 h-7 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="font-montserrat font-black text-xl text-white mb-2">Membership Not Active</h2>
            <p className="text-zinc-400 text-sm mb-6">Your membership doesn&apos;t appear to be active. Give us a call and we&apos;ll get you sorted out.</p>
            <a href="tel:605-718-1348"
              className="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-400 text-white font-bold px-7 py-3.5 rounded-full transition-all">
              Call (605) 718-1348
            </a>
            <button onClick={() => { setError(""); setStep("verify"); }}
              className="block mx-auto mt-4 text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
              ← Try again
            </button>
          </div>
        )}

        {/* ── Not found ── */}
        {step === "not-found" && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-9 text-center">
            <div className="w-14 h-14 bg-zinc-800 rounded-full flex items-center justify-center mx-auto mb-5">
              <svg className="w-7 h-7 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
            <h2 className="font-montserrat font-black text-xl text-white mb-2">Member Not Found</h2>
            <p className="text-zinc-400 text-sm mb-6">We couldn&apos;t find a membership with that information. Contact us and we&apos;ll help you out.</p>
            <a href="mailto:staff@ugf.club"
              className="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-400 text-white font-bold px-7 py-3.5 rounded-full transition-all">
              Email staff@ugf.club
            </a>
            <button onClick={() => { setError(""); setStep("verify"); }}
              className="block mx-auto mt-4 text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
              ← Try again
            </button>
          </div>
        )}

        {/* ── STEP 2: Assessment ── */}
        {step === "assessment" && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-7 sm:p-9">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-7 h-7 bg-green-500/10 rounded-full flex items-center justify-center flex-shrink-0">
                <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="text-green-400 font-semibold text-sm">Membership verified — welcome, {member.firstName}!</span>
            </div>
            <h2 className="font-montserrat font-black text-xl text-white mb-1">Your Fitness Assessment</h2>
            <p className="text-zinc-400 text-sm mb-6">The more detail you give, the better your plan will be.</p>
            <form onSubmit={handleSubmitAssessment} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Age</label>
                  <input required type="number" min="13" max="99" className={inputCls} placeholder="e.g. 34"
                    value={assessment.age} onChange={e => setAssessment(p => ({ ...p, age: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>Your Location</label>
                  <select required className={inputCls} value={assessment.location}
                    onChange={e => setAssessment(p => ({ ...p, location: e.target.value }))}>
                    <option value="">Select…</option>
                    <option>Black Hawk</option>
                    <option>Rapid Valley</option>
                  </select>
                </div>
              </div>

              <div>
                <label className={labelCls}>Current Fitness Level</label>
                <div className="flex flex-wrap gap-2">
                  {["Beginner", "Intermediate", "Advanced"].map(lvl => (
                    <Chip key={lvl} selected={assessment.fitnessLevel === lvl}
                      onClick={() => setAssessment(p => ({ ...p, fitnessLevel: lvl }))}>{lvl}</Chip>
                  ))}
                </div>
              </div>

              <div>
                <label className={labelCls}>Primary Goals <span className="text-zinc-500 font-normal">(select all that apply)</span></label>
                <div className="flex flex-wrap gap-2">
                  {GOALS.map(goal => (
                    <Chip key={goal} selected={assessment.goals.includes(goal)} onClick={() => toggleGoal(goal)}>{goal}</Chip>
                  ))}
                </div>
              </div>

              <div>
                <label className={labelCls}>Days Per Week You Can Train</label>
                <div className="flex flex-wrap gap-2">
                  {DAYS.map(d => (
                    <Chip key={d} selected={assessment.daysPerWeek === d}
                      onClick={() => setAssessment(p => ({ ...p, daysPerWeek: d }))}>{d} days</Chip>
                  ))}
                </div>
              </div>

              <div>
                <label className={labelCls}>Preferred Workout Time</label>
                <div className="flex flex-wrap gap-2">
                  {TIMES.map(t => (
                    <Chip key={t} selected={assessment.preferredTime === t}
                      onClick={() => setAssessment(p => ({ ...p, preferredTime: t }))}>{t}</Chip>
                  ))}
                </div>
              </div>

              <div>
                <label className={labelCls}>Activity Level Outside the Gym</label>
                <div className="flex flex-wrap gap-2">
                  {ACTIVITY_LEVELS.map(a => (
                    <Chip key={a} selected={assessment.currentActivity === a}
                      onClick={() => setAssessment(p => ({ ...p, currentActivity: a }))}>{a}</Chip>
                  ))}
                </div>
              </div>

              <div>
                <label className={labelCls}>Injuries or Physical Limitations <span className="text-zinc-500 font-normal">(optional)</span></label>
                <textarea rows={2} className={inputCls + " resize-none"} placeholder="e.g. bad left knee, lower back issues…"
                  value={assessment.injuries} onChange={e => setAssessment(p => ({ ...p, injuries: e.target.value }))} />
              </div>

              <div>
                <label className={labelCls}>Anything else we should know? <span className="text-zinc-500 font-normal">(optional)</span></label>
                <textarea rows={2} className={inputCls + " resize-none"} placeholder="e.g. training for a 5K, want to lose 20 lbs before summer…"
                  value={assessment.additionalNotes} onChange={e => setAssessment(p => ({ ...p, additionalNotes: e.target.value }))} />
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <button type="submit"
                disabled={!assessment.fitnessLevel || !assessment.daysPerWeek || !assessment.goals.length}
                className="w-full bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-montserrat font-bold py-4 rounded-xl transition-all text-base">
                Build My Workout Plan →
              </button>
            </form>
          </div>
        )}

        {/* ── Generating ── */}
        {step === "generating" && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-10 text-center">
            <div className="w-16 h-16 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-6 animate-pulse">
              <svg className="w-8 h-8 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <h2 className="font-montserrat font-black text-2xl text-white mb-2">Building Your Plan…</h2>
            <p className="text-zinc-400">Our AI trainer is reviewing your assessment and building a custom program just for you. This takes about 15–20 seconds.</p>
          </div>
        )}

        {/* ── STEP 3: Plan display ── */}
        {step === "plan" && (
          <div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-7 sm:p-9 mb-6">
              <div className="flex items-center gap-3 mb-6 pb-5 border-b border-zinc-800">
                <div className="w-10 h-10 bg-orange-500/10 rounded-full flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-orange-500" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                </div>
                <div>
                  <p className="text-zinc-400 text-xs uppercase tracking-wider font-semibold">Your Personalized Plan</p>
                  <p className="text-white font-bold">{member.firstName} {member.lastName}</p>
                </div>
              </div>
              <div>{renderPlan(plan)}</div>
            </div>
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
              <div className="flex flex-col sm:flex-row gap-3 justify-between items-center">
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      const blob = new Blob([plan], { type: "text/plain" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `UGF-Workout-Plan-${member.firstName}-${member.lastName}.txt`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="flex items-center gap-2 bg-orange-500 hover:bg-orange-400 text-white font-semibold px-5 py-2.5 rounded-full text-sm transition-all">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download Plan
                  </button>
                  <button
                    onClick={() => window.print()}
                    className="flex items-center gap-2 border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white font-semibold px-5 py-2.5 rounded-full text-sm transition-all">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                    </svg>
                    Print / Save PDF
                  </button>
                </div>
                <div className="flex gap-3">
                  <a href="tel:605-718-1348"
                    className="text-zinc-400 hover:text-orange-400 font-semibold text-sm transition-all">
                    Call the Gym
                  </a>
                  <span className="text-zinc-700">·</span>
                  <a href="mailto:staff@ugf.club"
                    className="text-zinc-400 hover:text-orange-400 font-semibold text-sm transition-all">
                    Email a Trainer
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
      <Footer />
    </div>
  );
}
