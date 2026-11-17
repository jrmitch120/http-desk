//! The History store's own thread (#151). Every write and read goes through it in
//! order, so a send's reply never waits for its entry to be written, and a list
//! asked for after a send returns sees that send. The store opens on first use, in
//! the config folder (`config_dir`, which the IPC tests replace), never the workspace.

use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

use httpdesk_core::history::{self, NewEntry, Store};
pub use httpdesk_core::history::{Finished, Masking, Pending, Query, Retention, FILE_NAME};

type Job = Box<dyn FnOnce(Result<&Store, &str>) + Send>;

#[derive(Default)]
pub struct History {
    jobs: Mutex<Option<Sender<Job>>>,
}

impl History {
    /// Writes `entry` to the store at `path`, then removes what `retention` no longer
    /// keeps, without waiting. A failed write is lost: the send it records has
    /// already been shown.
    pub fn record(&self, path: impl FnOnce() -> Option<PathBuf>, entry: NewEntry, retention: Retention) {
        self.submit(
            path,
            Box::new(move |store| {
                let recorded = store.map_err(str::to_string).and_then(|s| {
                    s.record(&entry).and_then(|id| s.trim(&retention, Some(id))).map_err(|e| e.to_string())
                });
                if let Err(e) = recorded {
                    eprintln!("Could not record a History entry: {e}");
                }
            }),
        );
    }

    /// Removes what `retention` doesn't keep from the store at `path`, without waiting.
    pub fn trim(&self, path: impl FnOnce() -> Option<PathBuf>, retention: Retention) {
        self.submit(
            path,
            Box::new(move |store| {
                if let Err(e) =
                    store.map_err(str::to_string).and_then(|s| s.trim(&retention, None).map_err(|e| e.to_string()))
                {
                    eprintln!("Could not apply History's retention: {e}");
                }
            }),
        );
    }

    /// Runs `read` on the store at `path`, after every write asked for before it.
    pub async fn read<T: Send + 'static>(
        &self,
        path: impl FnOnce() -> Option<PathBuf>,
        read: impl FnOnce(&Store) -> history::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.submit(
            path,
            Box::new(move |store| {
                let _ = tx.send(store.map_err(str::to_string).and_then(|s| read(s).map_err(|e| e.to_string())));
            }),
        );
        rx.await.map_err(|_| "History is unavailable".to_string())?
    }

    /// Queues `job`, starting the thread (which opens the store at `path`) on first use.
    fn submit(&self, path: impl FnOnce() -> Option<PathBuf>, job: Job) {
        let mut jobs = self.jobs.lock().unwrap();
        let tx = jobs.get_or_insert_with(|| start(path()));
        if let Err(mpsc::SendError(job)) = tx.send(job) {
            job(Err("History is unavailable"));
        }
    }
}

/// The store's thread, opening it at `path` (`None`: there's nowhere to keep it).
fn start(path: Option<PathBuf>) -> Sender<Job> {
    let (tx, rx) = mpsc::channel::<Job>();
    std::thread::Builder::new()
        .name("history".into())
        .spawn(move || {
            let store = match path {
                Some(p) => Store::open(&p).map_err(|e| e.to_string()),
                None => Err("History has no folder to be kept in".to_string()),
            };
            for job in rx {
                job(store.as_ref().map_err(String::as_str));
            }
        })
        .expect("History thread started");
    tx
}
