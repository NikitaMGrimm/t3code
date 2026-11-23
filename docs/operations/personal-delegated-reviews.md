# Delegated reviews in the personal fork

Keep one reviewer conversation for a change. Send corrections, responses, and unresolved
objections to its `childThreadId` with `t3_thread_send`; the child retains its conversation context.
After the original task completes, a follow-up creates a new task in the same child thread and
returns its `taskId`. Track that result separately: the original task and its published result stay
terminal. Use a distinct `clientRequestId` per new task or message, stable across retries.

The main agent evaluates findings against requirements and evidence and decides when it is
satisfied; reviewer approval is not a veto. Only then may it use `delegate_task` for a fresh reviewer
when an unbiased check would help. Give that reviewer the original brief, current change,
constraints, and verification evidence without steering its verdict with prior conclusions.
Do not rotate reviewers during ordinary follow-ups or disagreements; address any new supported
findings in the fresh reviewer's conversation.
