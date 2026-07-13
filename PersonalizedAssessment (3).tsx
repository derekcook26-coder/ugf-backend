"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type ChatMessage = { role: "assistant" | "user"; content: string };
type MemberInfo = { firstName: string; lastName: string; memberId: string };
type CoachProfile = Record<string, unknown>;

type Props = {
  apiBase: string;
  member: MemberInfo;
  onPlanGenerated: (plan: string) => void;
};

export default function PersonalizedAssessment({ apiBase, member, onPlanGenerated }: Props) {
  const welcome = `Welcome, ${member.firstName}. I'm your UGF AI Coach. I'll ask a few questions so I can build a plan around your goals, schedule, experience, and any limitations. This is a conversation, not a test.\n\nWhat made you decide to build a new workout plan today?`;

  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: welcome },
  ]);
  const [profile, setProfile] = useState<CoachProfile>({});
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<"assessment" | "summary" | "stopped">("assessment");
  const [readyToGenerate, setReadyToGenerate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function safeFetch(url: string, body: object) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      console.error(`[UGF] Non-JSON response from ${url} (status ${response.status}):`, text.slice(0, 500));
      throw new Error(`Server error ${response.status}: backend returned an unexpected response. Check the browser console for details.`);
    }
    const data = JSON.parse(text);
    if (!response.ok || data.error) throw new Error(data.error || `Request failed with status ${response.status}`);
    return data;
  }

  async function submitAnswer(event: FormEvent) {
    event.preventDefault();
    const answer = input.trim();
    if (!answer || loading || readyToGenerate || phase === "stopped") return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: answer }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError("");

    try {
      const data = await safeFetch(`${apiBase}/coach-message`, { member, messages: nextMessages, profile });
      setMessages((current) => [...current, { role: "assistant", content: data.reply }]);
      setProfile(data.profile || profile);
      setPhase(data.phase || "assessment");
      setReadyToGenerate(Boolean(data.readyToGenerate));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The coach could not respond.");
    } finally {
      setLoading(false);
    }
  }

  async function generatePlan() {
    setGenerating(true);
    setError("");
    try {
      const data = await safeFetch(`${apiBase}/generate-personalized-workout`, { member, profile, messages });
      onPlanGenerated(data.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your plan could not be generated.");
      setGenerating(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden">
      <div className="p-6 sm:p-8 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-orange-500 text-white font-black flex items-center justify-center">U</div>
          <div>
            <h2 className="font-montserrat font-black text-xl text-white">Meet Your UGF Coach</h2>
            <p className="text-zinc-400 text-sm">One question at a time. Built around your real life.</p>
          </div>
        </div>
      </div>

      <div className="min-h-[520px] max-h-[650px] overflow-y-auto p-5 sm:p-7 space-y-4">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[88%] rounded-2xl px-4 py-3 whitespace-pre-wrap leading-relaxed ${message.role === "user" ? "bg-orange-500 text-white rounded-br-md" : "bg-zinc-800 text-zinc-200 rounded-bl-md"}`}>
              {message.content}
            </div>
          </div>
        ))}
        {loading && <div className="flex justify-start"><div className="bg-zinc-800 text-zinc-400 rounded-2xl px-4 py-3">Thinking about your answer…</div></div>}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-zinc-800 p-5 sm:p-6">
        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

        {phase === "stopped" ? (
          <p className="text-sm text-zinc-400">The assessment has been paused for safety. Please follow the guidance above before continuing.</p>
        ) : readyToGenerate ? (
          <div>
            <p className="text-zinc-300 text-sm mb-4">Review the summary above. When it looks right, create your personalized game plan.</p>
            <button type="button" onClick={generatePlan} disabled={generating} className="w-full bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white font-montserrat font-bold py-4 rounded-xl transition-all">
              {generating ? "Building Your UGF Game Plan…" : "Create My UGF Game Plan →"}
            </button>
          </div>
        ) : (
          <form onSubmit={submitAnswer} className="flex gap-3">
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} rows={2} placeholder="Type your answer…" className="flex-1 resize-none bg-zinc-950 border border-zinc-700 focus:border-orange-500 focus:outline-none rounded-xl px-4 py-3 text-white placeholder-zinc-500" />
            <button type="submit" disabled={!input.trim() || loading} className="self-stretch bg-orange-500 hover:bg-orange-400 disabled:opacity-40 text-white font-bold px-5 rounded-xl transition-all">Send</button>
          </form>
        )}

        <p className="text-zinc-600 text-xs mt-4 text-center">General fitness guidance only. This tool does not diagnose medical conditions or replace advice from a qualified healthcare professional.</p>
      </div>
    </div>
  );
}
