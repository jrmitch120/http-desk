//! `httpdesk-text` built to WASM for the dev mock (src/dev/textCore.ts), so browser
//! tests parse and render `.http` text with the real core instead of a second
//! parser. Each function is called like the shell's command of the same name:
//! by name, with the same JSON arguments, giving back the same JSON result.
//!
//! The WASM interface is plain exports, no bindings generator: the caller puts
//! UTF-8 into buffers from [`text_alloc`], calls [`text_invoke`] (which frees
//! them), then reads the result (or error message) at [`text_output`].

use httpdesk_text::{HttpFile, Request};
use serde::de::DeserializeOwned;
use serde::Deserialize;

#[derive(Deserialize)]
struct Text {
    text: String,
}

#[derive(Deserialize)]
struct FileArgs {
    file: HttpFile,
}

#[derive(Deserialize)]
struct RequestArgs {
    request: Request,
}

fn args<T: DeserializeOwned>(command: &str, json: &str) -> Result<T, String> {
    serde_json::from_str(json).map_err(|e| format!("{command}: bad arguments: {e}"))
}

fn json(value: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// Runs `command` with JSON `args_json` and gives back its JSON result.
pub fn invoke(command: &str, args_json: &str) -> Result<String, String> {
    match command {
        // The shell's `request_source`: a request's Source view text.
        "request_source" => {
            let RequestArgs { request } = args(command, args_json)?;
            json(&httpdesk_text::request_source(&request))
        }
        // The shell's `parse_request`: the first request in `text` and the problems found reading it.
        "parse_request" => {
            let Text { text } = args(command, args_json)?;
            json(&httpdesk_text::parse_request(&text))
        }
        // The shell's `request_portability`.
        "request_portability" => {
            let RequestArgs { request } = args(command, args_json)?;
            json(&httpdesk_text::portability::request_portability(&request))
        }
        // The shell's `portability_text`: the constructs in a Source view's typed text.
        "portability_text" => {
            let Text { text } = args(command, args_json)?;
            json(&httpdesk_text::portability::portability(&text))
        }
        // What History keeps as a send's source text (`history::Pending::begin`).
        "request_text" => {
            let RequestArgs { request } = args(command, args_json)?;
            json(&httpdesk_text::request_text(&request))
        }
        // The shell's `request_problems`: what reading a request's source finds.
        "request_problems" => {
            let RequestArgs { request } = args(command, args_json)?;
            json(&httpdesk_text::request_problems(&request))
        }
        // What the shell's `workspace_problems` and `file_problems` read in a file's text
        // (`text_problems`: its problems and body files, by line in the file); the mock
        // answers whether each body file exists itself.
        "text_problems" => {
            let Text { text } = args(command, args_json)?;
            json(&httpdesk_text::text_problems(&text))
        }
        // A whole `.http` file, as the shell reads one from disk.
        "parse_file" => {
            let Text { text } = args(command, args_json)?;
            json(&httpdesk_text::parse(&text))
        }
        // The shell's `parse_file_text`: a file view's text, read as a whole file with its problems.
        "parse_file_text" => {
            let Text { text } = args(command, args_json)?;
            json(&httpdesk_text::parse_with_problems(&text))
        }
        // The shell's `file_text`: a whole file's text, as saving writes it (the mock's
        // `save_http_file` writes this, then reads it back with `parse_file`). Unlike the
        // shell's save, it refuses no field.
        "file_text" => {
            let FileArgs { file } = args(command, args_json)?;
            json(&httpdesk_text::serialize(&file))
        }
        _ => Err(format!("the WASM core has no command {command}")),
    }
}

#[cfg(target_arch = "wasm32")]
mod exports {
    use std::cell::RefCell;

    thread_local! {
        /// The last call's result, until the next call.
        static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    /// A buffer of `len` bytes for the caller to fill; [`text_invoke`] frees it.
    #[no_mangle]
    pub extern "C" fn text_alloc(len: usize) -> *mut u8 {
        let mut buf = Vec::<u8>::with_capacity(len);
        let ptr = buf.as_mut_ptr();
        std::mem::forget(buf);
        ptr
    }

    unsafe fn take(ptr: *mut u8, len: usize) -> String {
        String::from_utf8_lossy(&Vec::from_raw_parts(ptr, len, len)).into_owned()
    }

    /// Runs [`super::invoke`] on two buffers from [`text_alloc`] (freeing them);
    /// 1 when it succeeded, 0 when the output is an error message.
    ///
    /// # Safety
    /// Each pointer must come from [`text_alloc`] with that same length, filled.
    #[no_mangle]
    pub unsafe extern "C" fn text_invoke(command: *mut u8, command_len: usize, args: *mut u8, args_len: usize) -> u32 {
        let (command, args) = (take(command, command_len), take(args, args_len));
        let (ok, output) = match super::invoke(&command, &args) {
            Ok(result) => (1, result),
            Err(message) => (0, message),
        };
        OUTPUT.with(|o| *o.borrow_mut() = output.into_bytes());
        ok
    }

    #[no_mangle]
    pub extern "C" fn text_output() -> *const u8 {
        OUTPUT.with(|o| o.borrow().as_ptr())
    }

    #[no_mangle]
    pub extern "C" fn text_output_len() -> usize {
        OUTPUT.with(|o| o.borrow().len())
    }
}
