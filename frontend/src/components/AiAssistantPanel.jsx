import React, { useEffect, useRef, useState } from 'react';
import { Bot, Send, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api.js';

const QUICK_PROMPTS = [
  "What's due this week?",
  'Which debt should I pay first?',
  'Compare Snowball vs Avalanche with ₹3000 extra',
  'Add a ₹25000 Visa Card at 24% interest due on the 18th',
];

export default function AiAssistantPanel({ onDebtCreated }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    api('/ai/history')
      .then((d) => setMessages(d.messages || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const sendMessage = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setError('');
    setInput('');
    setMessages((prev) => [...prev, { id: `tmp-${Date.now()}`, role: 'user', content: trimmed }]);
    setBusy(true);
    try {
      const res = await api('/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ message: trimmed }),
      });
      setMessages((prev) => [
        ...prev,
        { id: `ai-${Date.now()}`, role: 'assistant', content: res.reply, provider: res.provider },
      ]);
      if (res.created_debt && onDebtCreated) {
        onDebtCreated();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
    try {
      await api('/ai/history', { method: 'DELETE' });
      setMessages([]);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <aside className="panel ai-panel">
      <div className="panel-head ai-head">
        <div>
          <p className="eyebrow">AI REPAYMENT COPILOT</p>
          <h2><Bot size={18} /> Smart Assistant</h2>
        </div>
        {messages.length > 0 && (
          <button type="button" className="icon-btn" onClick={clearHistory} title="Clear chat">
            <Trash2 size={15} />
          </button>
        )}
      </div>

      <div className="ai-chips">
        {QUICK_PROMPTS.map((q) => (
          <button type="button" key={q} className="chip-btn" onClick={() => sendMessage(q)} disabled={busy}>
            <Sparkles size={12} /> {q}
          </button>
        ))}
      </div>

      <div className="ai-messages">
        {!messages.length && (
          <div className="ai-welcome">
            Ask me about upcoming due dates, overdue payments, Snowball vs Avalanche payoff plans—or type a debt in plain English and I&apos;ll add it to your tracker!
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ai-bubble ${m.role === 'user' ? 'user' : 'assistant'}`}>
            <div className="ai-text">{m.content}</div>
          </div>
        ))}
        {busy && <div className="ai-bubble assistant thinking">Analyzing your repayment schedule…</div>}
        <div ref={endRef} />
      </div>

      {error && <div className="notice error">{error}</div>}

      <form
        className="ai-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask or say: Add ₹40k card due on 20th…"
          disabled={busy}
        />
        <button type="submit" className="primary small" disabled={busy || !input.trim()}>
          <Send size={15} />
        </button>
      </form>
    </aside>
  );
}
