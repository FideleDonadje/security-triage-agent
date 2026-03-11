import { useState, useEffect, useRef, useCallback } from 'react';
import { sendChat } from '../lib/api';

const INITIAL_MESSAGE = 'check for new security findings';

interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
  error?: boolean;
}

function makeId() {
  return `${Date.now()}-${Math.random()}`;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Prevent the auto-send from firing more than once
  const autoSentRef = useRef(false);

  // Auto-scroll whenever messages or loading state change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus the textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const addMessage = useCallback((role: Message['role'], content: string, error = false): string => {
    const id = makeId();
    setMessages((prev) => [...prev, { id, role, content, timestamp: new Date(), error }]);
    return id;
  }, []);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;
    addMessage('user', text);
    setLoading(true);
    try {
      const result = await sendChat(text, sessionId);
      setSessionId(result.session_id);
      addMessage('agent', result.reply);
    } catch (err) {
      addMessage('agent', `Error: ${(err as Error).message}`, true);
    } finally {
      setLoading(false);
    }
  }, [loading, sessionId, addMessage]);

  // Auto-send the initial findings check when the component mounts
  useEffect(() => {
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    void send(INITIAL_MESSAGE);
  }, [send]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    setInput('');
    void send(text);
  }, [send, input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      setInput('');
      void send(input.trim());
    }
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.panelHeader}>
        <span style={styles.panelTitle}>Chat</span>
        {sessionId && (
          <span style={styles.sessionBadge} title={sessionId}>Session active</span>
        )}
      </div>

      {/* Message list */}
      <div style={styles.messageList}>
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {loading && <TypingIndicator />}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div style={styles.inputArea}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about findings, request investigation, or queue a remediation..."
          rows={3}
          disabled={loading}
          style={styles.textarea}
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          style={styles.sendBtn}
        >
          {loading ? 'Thinking...' : 'Send'}
        </button>
        <div style={styles.inputHint}>Enter to send  |  Shift+Enter for newline</div>
      </div>
    </div>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div style={{ ...styles.msgRow, flexDirection: isUser ? 'row-reverse' : 'row' }}>
      <div style={{
        ...styles.avatar,
        background: isUser ? 'var(--blue)' : 'var(--surface2)',
        color: isUser ? '#fff' : 'var(--muted)',
      }}>
        {isUser ? 'A' : 'AI'}
      </div>
      <div style={{
        ...styles.bubble,
        background: isUser ? 'rgba(56, 139, 253, 0.12)' : 'var(--surface)',
        border: `1px solid ${isUser ? 'rgba(56, 139, 253, 0.3)' : 'var(--border)'}`,
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        ...(message.error ? { borderColor: 'rgba(248, 81, 73, 0.4)', color: 'var(--red)' } : {}),
      }}>
        <MessageContent content={message.content} />
        <div style={styles.timestamp}>
          {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}

// ── Message content ────────────────────────────────────────────────────────────

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 14 }}>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const code = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
          return <pre key={i} style={styles.codeBlock}>{code}</pre>;
        }
        return <span key={i}>{part}</span>;
      })}
    </div>
  );
}

// ── Typing indicator ───────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div style={{ ...styles.msgRow, flexDirection: 'row' }}>
      <div style={{ ...styles.avatar, background: 'var(--surface2)', color: 'var(--muted)' }}>AI</div>
      <div style={{ ...styles.bubble, background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div style={styles.typingDots}>
          <span style={styles.dot} />
          <span style={{ ...styles.dot, animationDelay: '0.2s' }} />
          <span style={{ ...styles.dot, animationDelay: '0.4s' }} />
        </div>
        <style>{dotAnimation}</style>
      </div>
    </div>
  );
}

const dotAnimation = `
@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40% { transform: translateY(-4px); opacity: 1; }
}`;

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg)',
    overflow: 'hidden',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
    flexShrink: 0,
  },
  panelTitle: {
    fontWeight: 600,
    fontSize: 14,
  },
  sessionBadge: {
    fontSize: 11,
    color: 'var(--green)',
    background: 'rgba(63, 185, 80, 0.1)',
    border: '1px solid rgba(63, 185, 80, 0.3)',
    borderRadius: 20,
    padding: '2px 8px',
  },
  messageList: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  msgRow: {
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
    flexShrink: 0,
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 10,
    padding: '10px 14px',
    color: 'var(--text)',
  },
  timestamp: {
    fontSize: 11,
    color: 'var(--muted)',
    marginTop: 6,
  },
  codeBlock: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    overflowX: 'auto',
    margin: '8px 0',
    whiteSpace: 'pre',
  },
  typingDots: {
    display: 'flex',
    gap: 4,
    padding: '4px 2px',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--muted)',
    display: 'inline-block',
    animation: 'bounce 1.2s infinite',
  },
  inputArea: {
    borderTop: '1px solid var(--border)',
    padding: 12,
    background: 'var(--surface)',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  textarea: {
    width: '100%',
    resize: 'none',
    padding: '8px 12px',
    lineHeight: 1.5,
    minHeight: 70,
  },
  sendBtn: {
    alignSelf: 'flex-end',
    background: 'var(--blue)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    padding: '6px 20px',
    borderRadius: 6,
  },
  inputHint: {
    fontSize: 11,
    color: 'var(--muted)',
  },
};
