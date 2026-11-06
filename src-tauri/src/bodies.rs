//! Recent response bodies, kept so "save to file" can write the bytes the
//! UI only shows as text. Memory is capped by count and by total bytes.

use std::collections::VecDeque;
use std::sync::Arc;

pub(crate) struct RecentBodies {
    max_count: usize,
    max_bytes: usize,
    total_bytes: usize,
    entries: VecDeque<(String, Arc<[u8]>)>,
}

impl Default for RecentBodies {
    fn default() -> Self {
        RecentBodies::new(20, 256 * 1024 * 1024)
    }
}

impl RecentBodies {
    pub(crate) fn new(max_count: usize, max_bytes: usize) -> Self {
        RecentBodies { max_count, max_bytes, total_bytes: 0, entries: VecDeque::new() }
    }

    /// Adds the newest body, evicting the oldest ones until both caps hold.
    /// The newest is always kept, even if it alone is over the byte cap, so
    /// the response on screen can still be saved.
    pub(crate) fn push(&mut self, id: String, body: Vec<u8>) {
        self.total_bytes += body.len();
        self.entries.push_back((id, body.into()));
        while self.entries.len() > 1 && (self.entries.len() > self.max_count || self.total_bytes > self.max_bytes) {
            if let Some((_, old)) = self.entries.pop_front() {
                self.total_bytes -= old.len();
            }
        }
    }

    pub(crate) fn get(&self, id: &str) -> Option<Arc<[u8]>> {
        self.entries.iter().find(|(i, _)| i == id).map(|(_, b)| b.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::RecentBodies;

    fn kept(b: &RecentBodies, ids: &[&str]) -> Vec<String> {
        ids.iter().filter(|id| b.get(id).is_some()).map(|s| s.to_string()).collect()
    }

    #[test]
    fn evicts_oldest_bodies_once_total_bytes_exceed_the_cap() {
        let mut b = RecentBodies::new(20, 100);
        b.push("a".into(), vec![1; 40]);
        b.push("b".into(), vec![2; 40]);
        b.push("c".into(), vec![3; 40]);
        assert_eq!(kept(&b, &["a", "b", "c"]), ["b", "c"]);
        assert_eq!(&*b.get("c").unwrap(), &[3; 40][..]);
        b.push("d".into(), vec![4; 90]);
        assert_eq!(kept(&b, &["a", "b", "c", "d"]), ["d"]);
    }

    #[test]
    fn keeps_the_newest_body_even_when_it_alone_exceeds_the_cap() {
        let mut b = RecentBodies::new(20, 100);
        b.push("a".into(), vec![1; 10]);
        b.push("big".into(), vec![0; 500]);
        assert_eq!(kept(&b, &["a", "big"]), ["big"]);
    }

    #[test]
    fn evicts_oldest_bodies_beyond_the_count_cap() {
        let mut b = RecentBodies::new(2, 1000);
        for id in ["a", "b", "c"] {
            b.push(id.into(), vec![0; 1]);
        }
        assert_eq!(kept(&b, &["a", "b", "c"]), ["b", "c"]);
    }
}
