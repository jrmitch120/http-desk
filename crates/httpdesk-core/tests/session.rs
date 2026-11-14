//! The Session: what HttpDesk remembers about a workspace from one send to the next.

use std::collections::HashMap;

use httpdesk_core::session::Session;

fn answers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[test]
fn a_new_session_remembers_no_prompt_answers() {
    let session = Session::default();
    assert_eq!(session.prompt_answers().get("req-1"), HashMap::new());
}

#[test]
fn prompt_answers_are_remembered_per_request() {
    let session = Session::default();
    session.prompt_answers().answer("req-1", answers(&[("otp", "123456")]));
    session.prompt_answers().answer("req-2", answers(&[("otp", "654321")]));

    assert_eq!(session.prompt_answers().get("req-1"), answers(&[("otp", "123456")]));
    assert_eq!(session.prompt_answers().get("req-2"), answers(&[("otp", "654321")]));
}

#[test]
fn answering_more_prompts_keeps_the_requests_earlier_answers() {
    let session = Session::default();
    session.prompt_answers().answer("req-1", answers(&[("otp", "123456"), ("user", "ann")]));
    session.prompt_answers().answer("req-1", answers(&[("password", "s3cret"), ("user", "bob")]));

    assert_eq!(
        session.prompt_answers().get("req-1"),
        answers(&[("otp", "123456"), ("password", "s3cret"), ("user", "bob")])
    );
}

#[test]
fn forgetting_a_requests_prompt_answers_leaves_other_requests_alone() {
    let session = Session::default();
    session.prompt_answers().answer("req-1", answers(&[("otp", "123456")]));
    session.prompt_answers().answer("req-2", answers(&[("otp", "654321")]));

    session.prompt_answers().forget("req-1");

    assert_eq!(session.prompt_answers().get("req-1"), HashMap::new());
    assert_eq!(session.prompt_answers().get("req-2"), answers(&[("otp", "654321")]));
}
