//! Runs: sending a selection of requests in order with the Session carried from
//! each to the next (GLOSSARY "Run"). Each request goes through [`send::send`], the
//! same flow as a single send.
//!
//! A request in a run **fails** on a network error, a script error, a failed test or
//! assert, or a blocked send. An HTTP error status alone is not a failure. A failure
//! doesn't stop the run.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

use crate::exec::{ExecError, HttpResponse};
use crate::send::{self, Outgoing, SendContext, Sent};

/// What a run reports about one of its requests, in this order: `Sending`, then one of
/// the others. A request the run never reached reports nothing.
pub enum RunEvent {
    /// It's being sent.
    Sending,
    /// It got a response; `failed` when a test or assert failed or a script errored.
    Sent { sent: Box<Sent>, failed: bool },
    /// It got no response: it was blocked or the network failed. Always a failure.
    Failed(ExecError),
    /// The run was stopped while it was being sent.
    Cancelled,
}

/// Whether a request that got `response` failed: a test or assert failed, or a
/// script errored (reported as a failed test). Its status doesn't count.
pub fn failed(response: &HttpResponse) -> bool {
    response.tests.iter().any(|t| !t.passed)
}

/// Stops a run, including the request in flight. Clones share the signal.
#[derive(Clone, Default)]
pub struct Cancel(Arc<CancelState>);

#[derive(Default)]
struct CancelState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancel {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once the run is cancelled.
    async fn cancelled(&self) {
        loop {
            // Created before checking, so a cancel in between still wakes it.
            let notified = self.0.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// Sends `requests` in order in `ctx`, reporting each one's progress to `on_event`
/// with its index. Stops when `cancel` fires, the request in flight included.
/// Returns whether it was cancelled.
pub async fn run(
    ctx: &SendContext,
    requests: Vec<Outgoing>,
    cancel: &Cancel,
    mut on_event: impl FnMut(usize, RunEvent),
) -> bool {
    for (index, out) in requests.into_iter().enumerate() {
        if cancel.is_cancelled() {
            return true;
        }
        on_event(index, RunEvent::Sending);
        let result = tokio::select! {
            result = send::send(ctx, out, |_| {}) => result,
            _ = cancel.cancelled() => {
                on_event(index, RunEvent::Cancelled);
                return true;
            }
        };
        on_event(
            index,
            match result {
                Ok(sent) => {
                    let failed = failed(&sent.response);
                    RunEvent::Sent { sent: Box::new(sent), failed }
                }
                Err(e) => RunEvent::Failed(e),
            },
        );
    }
    cancel.is_cancelled()
}
