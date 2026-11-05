//! OpenAPI loading, validation and `.http` generation tests.

use httpdesk_core::openapi::*;
use httpdesk_core::*;

/// (name, value, enabled) — descriptions are asserted separately.
fn kv(items: &[KeyValue]) -> Vec<(&str, &str, bool)> {
    items.iter().map(|i| (i.name.as_str(), i.value.as_str(), i.enabled)).collect()
}

const PETSTORE: &str = include_str!("fixtures/openapi/petstore-3.0.yaml");
const LIBRARY: &str = include_str!("fixtures/openapi/library-3.1.json");

fn petstore() -> OpenApiDoc {
    OpenApiDoc::parse(PETSTORE, None).expect("petstore parses")
}

fn library() -> OpenApiDoc {
    OpenApiDoc::parse(LIBRARY, None).expect("library parses")
}

fn generate(doc: &OpenApiDoc, grouping: Grouping) -> GenerationOutput {
    doc.generate(&GenerateOptions { grouping, ..Default::default() })
}

fn file<'a>(out: &'a GenerationOutput, name: &str) -> &'a HttpFile {
    &out.files.iter().find(|f| f.relative_path == name).unwrap_or_else(|| panic!("no {name}")).file
}

fn request<'a>(f: &'a HttpFile, name: &str) -> &'a Request {
    f.requests.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("no request {name}"))
}

// ---------------------------------------------------------------- summary

#[test]
fn summarizes_openapi_30_yaml() {
    let s = petstore().summary();
    assert_eq!(s.title, "Swagger Petstore");
    assert_eq!(s.version, "1.0.0");
    assert_eq!(s.openapi_version, "3.0.3");
    assert_eq!(s.tags, ["pet", "store"]);
    assert_eq!(s.servers[0].url, "https://petstore.example.com/v1", "server variables use defaults");
    assert_eq!(s.servers[0].description.as_deref(), Some("Production"));
    let ids: Vec<_> = s.operations.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(ids, ["listPets", "createPet", "showPetById", "deletePet", "uploadPhoto", "placeOrder", "GET /health"]);
    let delete = &s.operations[3];
    assert_eq!((delete.method.as_str(), delete.path.as_str(), delete.deprecated), ("DELETE", "/pets/{petId}", true));
    assert!(s.warnings.is_empty(), "{:?}", s.warnings);
}

#[test]
fn summarizes_openapi_31_json_and_ignores_webhooks() {
    let s = library().summary();
    assert_eq!(s.openapi_version, "3.1.0");
    assert_eq!(s.operations.len(), 3, "webhooks are not operations");
    assert_eq!(s.operations[2].id, "GET /categories/{categoryId}");
    assert_eq!(s.tags, ["books", "categories"]);
}

// ---------------------------------------------------------------- validation

#[test]
fn rejects_invalid_documents_with_clear_errors() {
    let err = OpenApiDoc::parse("swagger: '2.0'\ninfo: {title: x, version: '1'}\npaths: {}\n", None).unwrap_err();
    assert!(err.to_string().contains("Swagger 2.0"), "{err}");

    let err = OpenApiDoc::parse("name: not a spec\n", None).unwrap_err();
    assert!(matches!(err, OpenApiError::NotOpenApi(_)), "{err}");

    let err = OpenApiDoc::parse("openapi: 3.0.0\ninfo: [unclosed\n", None).unwrap_err();
    assert!(matches!(err, OpenApiError::Parse(_)), "{err}");

    let err = OpenApiDoc::parse("openapi: 2.5.0\ninfo: {title: x, version: '1'}\npaths: {}\n", None).unwrap_err();
    assert!(matches!(err, OpenApiError::Unsupported(_)), "{err}");

    let err = OpenApiDoc::parse("openapi: 3.0.0\ninfo: {title: x, version: '1'}\n", None).unwrap_err();
    assert!(err.to_string().contains("paths"), "{err}");

    let err = OpenApiDoc::parse("openapi: 3.0.0\npaths: {}\n", None).unwrap_err();
    assert!(err.to_string().contains("info"), "{err}");

    // 3.1 allows documents without paths; that's a warning, not an error.
    let doc = OpenApiDoc::parse("openapi: 3.1.0\ninfo: {title: x, version: '1'}\n", None).unwrap();
    assert_eq!(doc.summary().warnings, ["The specification defines no paths"]);
}

#[test]
fn errors_serialize_as_messages() {
    let err = OpenApiDoc::parse("{}", None).unwrap_err();
    assert_eq!(serde_json::to_value(&err).unwrap(), serde_json::Value::String(err.to_string()));
}

// ---------------------------------------------------------------- generation

#[test]
fn groups_by_tag_path_and_single_file() {
    let doc = petstore();
    let names = |g| generate(&doc, g).files.iter().map(|f| f.relative_path.clone()).collect::<Vec<_>>();
    assert_eq!(names(Grouping::Tag), ["pet.http", "store.http", "default.http"]);
    assert_eq!(names(Grouping::Path), ["pets.http", "store.http", "health.http"]);
    assert_eq!(names(Grouping::Single), ["swagger-petstore.http"]);

    let out = doc.generate(&GenerateOptions {
        grouping: Grouping::Single,
        single_file_name: Some("petstore.http".into()),
        ..Default::default()
    });
    assert_eq!(out.files[0].relative_path, "petstore.http");
    assert_eq!(out.files[0].file.requests.len(), 7);
}

#[test]
fn generates_only_selected_operations() {
    let out = petstore().generate(&GenerateOptions {
        operation_ids: vec!["createPet".into(), "GET /health".into()],
        ..Default::default()
    });
    let names: Vec<_> = out.files.iter().flat_map(|f| f.file.requests.iter().map(|r| r.name.clone())).collect();
    assert_eq!(names, ["Create a pet", "Health check"]);
}

#[test]
fn query_and_header_params_follow_required_flag() {
    let out = generate(&petstore(), Grouping::Tag);
    let list = request(file(&out, "pet.http"), "List all pets");
    assert_eq!(list.url, "{{baseUrl}}/pets");
    assert_eq!(kv(&list.query.items), [("limit", "20", false), ("status", "available", true)]);
    let docs: Vec<_> = list.query.items.iter().map(|i| i.description.as_str()).collect();
    assert_eq!(docs, ["How many items to return at one time (max 100).", "Required. One of: available, pending, sold."]);
    assert_eq!(list.headers.items.iter().find(|h| h.name == "X-Trace").unwrap().description, "Required. Default: trace-1.");
    let headers: Vec<_> = list.headers.items.iter().map(|h| (h.name.as_str(), h.value.as_str(), h.enabled)).collect();
    assert_eq!(
        headers,
        [
            ("Accept", "application/json", true),
            ("X-Request-ID", "3fa85f64-5717-4562-b3fc-2c963f66afa6", false),
            ("X-Trace", "trace-1", true),
        ]
    );
    assert_eq!(list.comments, ["Returns all pets the caller can see.", "", "Supports paging."]);
    assert_eq!(list.directive("name"), Some("listPets"));
}

#[test]
fn path_params_become_file_variables() {
    let out = generate(&petstore(), Grouping::Tag);
    let pet = file(&out, "pet.http");
    assert_eq!(pet.header.variables, vec![Variable { name: "petId".into(), value: "42".into() }]);
    assert_eq!(request(pet, "Info for a specific pet").url, "{{baseUrl}}/pets/{{petId}}");
    assert_eq!(request(pet, "Upload a photo").url, "{{baseUrl}}/pets/{{petId}}/photo");

    let lib = generate(&library(), Grouping::Tag);
    assert_eq!(file(&lib, "categories.http").header.variables[0], Variable { name: "categoryId".into(), value: "fiction".into() });
}

#[test]
fn auth_is_derived_from_security_requirements() {
    let out = generate(&petstore(), Grouping::Tag);
    let pet = file(&out, "pet.http");
    let list = request(pet, "List all pets");
    assert_eq!((list.auth.kind, list.auth.token.as_str()), (AuthKind::Bearer, "{{token}}"), "global security");
    let create = request(pet, "Create a pet");
    assert_eq!((create.auth.kind, create.auth.username.as_str(), create.auth.password.as_str()), (AuthKind::Basic, "{{username}}", "{{password}}"));
    let show = request(pet, "Info for a specific pet");
    assert_eq!(show.auth.kind, AuthKind::ApiKey);
    assert_eq!((show.auth.key_name.as_str(), show.auth.key_value.as_str(), show.auth.key_location), ("X-API-Key", "{{api_key}}", ApiKeyLocation::Header));
    let order = request(file(&out, "store.http"), "Place an order");
    assert_eq!(order.auth.kind, AuthKind::None, "`security: []` disables auth");

    let lib = generate(&library(), Grouping::Tag);
    let create = request(file(&lib, "books.http"), "Add a book");
    assert_eq!((create.auth.key_location, create.auth.key_name.as_str()), (ApiKeyLocation::Query, "api_key"));
    let cat = request(file(&lib, "categories.http"), "Get a category tree");
    assert_eq!((cat.auth.kind, cat.auth.token.as_str()), (AuthKind::Bearer, "{{accessToken}}"), "oauth2 → bearer");
}

#[test]
fn bodies_are_derived_from_schemas_and_examples() {
    let out = generate(&petstore(), Grouping::Tag);
    let pet = file(&out, "pet.http");

    let create = request(pet, "Create a pet");
    assert_eq!(create.body.mode, BodyMode::Json);
    assert_eq!(create.header("Content-Type").unwrap().value, "application/json", "JSON preferred over XML");
    assert_eq!(create.body.text, "{\n  \"name\": \"Rex\",\n  \"tag\": \"string\",\n  \"birthday\": \"2024-01-01\"\n}");

    let upload = request(pet, "Upload a photo");
    assert_eq!(upload.body.mode, BodyMode::Multipart);
    assert_eq!(upload.header("Content-Type").unwrap().value, "multipart/form-data; boundary=WebAppBoundary");
    assert!(upload.body.text.contains("name=\"file\"; filename=\"file.png\"\nContent-Type: image/png\n\n< ./file.png"), "{}", upload.body.text);
    assert!(upload.body.text.contains("name=\"caption\"\n\nRex at the beach"));
    assert!(upload.body.text.contains("name=\"metadata\"\nContent-Type: application/json\n\n{\"takenAt\":\"2024-01-01T12:00:00Z\"}"));
    assert!(upload.body.text.ends_with("--WebAppBoundary--"));

    let order = request(file(&out, "store.http"), "Place an order");
    assert_eq!(order.body.mode, BodyMode::FormUrlEncoded);
    assert_eq!(order.body.text, "petId=7&quantity=1&note=leave%20at%20the%20door");

    // Delete: deprecated, cookie param, no body.
    let delete = request(pet, "deletePet");
    assert_eq!(delete.comments[0], "DEPRECATED");
    assert_eq!(delete.header("Cookie").map(|h| (h.value.as_str(), h.enabled)), Some(("session=abc123", false)));
    assert_eq!(delete.body.mode, BodyMode::None);
}

#[test]
fn openapi_31_schemas_handle_type_arrays_const_and_recursion() {
    let out = generate(&library(), Grouping::Tag);
    let create = request(file(&out, "books.http"), "Add a book");
    let body: serde_json::Value = serde_json::from_str(&create.body.text).unwrap();
    assert_eq!(
        body,
        serde_json::json!({
            "title": "Dune", "subtitle": "string", "pages": 1, "kind": "book",
            "authors": ["Frank Herbert"], "isbn": "978-0441013593"
        })
    );
    let search = request(file(&out, "books.http"), "Search books");
    assert_eq!(kv(&search.query.items), [("q", "dune", true), ("filter[year]", "1965", false), ("filter[lang]", "en", false)]);
}

#[test]
fn recursive_schemas_terminate() {
    let spec = r##"{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{"/n":{"post":{
        "requestBody":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Node"}}}},
        "responses":{"200":{"description":"ok"}}}}},
        "components":{"schemas":{"Node":{"type":"object","properties":{
            "name":{"type":"string"},"children":{"type":"array","items":{"$ref":"#/components/schemas/Node"}},
            "parent":{"$ref":"#/components/schemas/Node"}}}}}}"##;
    let out = OpenApiDoc::parse(spec, None).unwrap().generate(&GenerateOptions::default());
    let body = &out.files[0].file.requests[0].body.text;
    assert_eq!(body, "{\n  \"name\": \"string\",\n  \"children\": []\n}");
}

#[test]
fn xml_and_binary_bodies() {
    let spec = r##"
openapi: 3.0.0
info: {title: t, version: '1'}
paths:
  /xml:
    put:
      requestBody:
        content:
          application/xml:
            schema: {$ref: '#/components/schemas/Item'}
      responses: {'200': {description: ok}}
  /blob:
    put:
      requestBody:
        content:
          image/png:
            schema: {type: string, format: binary}
      responses: {'200': {description: ok}}
components:
  schemas:
    Item:
      type: object
      properties:
        name: {type: string, example: "A & B"}
        tags: {type: array, items: {type: string}}
"##;
    let out = OpenApiDoc::parse(spec, None).unwrap().generate(&GenerateOptions::default());
    let reqs = &out.files[0].file.requests;
    assert_eq!(reqs[0].body.mode, BodyMode::Xml);
    assert_eq!(
        reqs[0].body.text,
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Item>\n  <name>A &amp; B</name>\n  <tags>string</tags>\n</Item>"
    );
    assert_eq!(reqs[1].body.mode, BodyMode::File);
    assert_eq!(reqs[1].body.text, "< ./body.png");
    assert_eq!(reqs[1].header("Content-Type").unwrap().value, "image/png");
}

#[test]
fn environments_hold_servers_and_secrets() {
    let out = generate(&petstore(), Grouping::Tag);
    let names: Vec<_> = out.environments.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["production", "local-development"]);
    assert_eq!(out.environments[0].variables, [("baseUrl".to_string(), "https://petstore.example.com/v1".to_string())]);
    assert_eq!(out.environments[1].variables[0].1, "http://localhost:8080/v1");
    let secrets: Vec<_> = out.environments[0].secrets.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert_eq!(secrets, [("token", ""), ("username", ""), ("password", ""), ("api_key", "")]);

    let custom = petstore().generate(&GenerateOptions { base_url_variable: "petstoreUrl".into(), ..Default::default() });
    assert_eq!(custom.environments[0].variables[0].0, "petstoreUrl");
    assert!(custom.files[0].file.requests[0].url.starts_with("{{petstoreUrl}}/"));

    let lib = generate(&library(), Grouping::Tag);
    assert_eq!(lib.environments.len(), 1);
    assert_eq!(lib.environments[0].name, "default");

    let bare = OpenApiDoc::parse("openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths: {}\n", None).unwrap();
    let env = &bare.generate(&GenerateOptions::default()).environments[0];
    assert_eq!((env.name.as_str(), env.variables[0].1.as_str()), ("default", "http://localhost"));
}

#[test]
fn generated_files_serialize_and_reparse() {
    for doc in [petstore(), library()] {
        for grouping in [Grouping::Tag, Grouping::Path, Grouping::Single] {
            for f in generate(&doc, grouping).files {
                let text = serialize(&f.file);
                let back = parse(&text);
                assert_eq!(back.requests.len(), f.file.requests.len(), "{text}");
                assert_eq!(back.header.variables, f.file.header.variables);
                for (a, b) in back.requests.iter().zip(&f.file.requests) {
                    assert_eq!((&a.name, &a.method, &a.url), (&b.name, &b.method, &b.url));
                    assert_eq!(a.query.items.len(), b.query.items.len(), "{text}");
                    assert_eq!(a.auth, b.auth, "{text}");
                    assert_eq!(a.body.text, b.body.text, "{text}");
                    assert_eq!(a.body.mode, b.body.mode, "{text}");
                }
            }
        }
    }
}

#[test]
fn snapshot_petstore_pet_file() {
    let out = generate(&petstore(), Grouping::Tag);
    insta::assert_snapshot!("petstore_pet", serialize(file(&out, "pet.http")));
    insta::assert_snapshot!("petstore_store", serialize(file(&out, "store.http")));
}

#[test]
fn snapshot_library_books_file() {
    let out = generate(&library(), Grouping::Tag);
    insta::assert_snapshot!("library_books", serialize(file(&out, "books.http")));
}

// ---------------------------------------------------------------- external refs

#[test]
fn resolves_relative_file_refs() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("schemas")).unwrap();
    std::fs::write(
        dir.path().join("schemas/pet.yaml"),
        "Pet:\n  type: object\n  properties:\n    name: {type: string, example: Fido}\n    owner: {$ref: '#/Owner'}\nOwner:\n  type: object\n  properties:\n    email: {type: string, format: email}\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("api.yaml"),
        "openapi: 3.0.0\ninfo: {title: Ext, version: '1'}\npaths:\n  /pets:\n    post:\n      requestBody:\n        content:\n          application/json:\n            schema: {$ref: './schemas/pet.yaml#/Pet'}\n      responses: {'200': {description: ok}}\n  /missing:\n    post:\n      requestBody:\n        content:\n          application/json:\n            schema: {$ref: './nope.yaml#/X'}\n      responses: {'200': {description: ok}}\n",
    )
    .unwrap();
    let doc = OpenApiDoc::load_file(&dir.path().join("api.yaml")).unwrap();
    let out = doc.generate(&GenerateOptions::default());
    let body: serde_json::Value = serde_json::from_str(&out.files[0].file.requests[0].body.text).unwrap();
    assert_eq!(body, serde_json::json!({"name": "Fido", "owner": {"email": "user@example.com"}}));
    assert!(out.warnings.iter().any(|w| w.contains("nope.yaml")), "{:?}", out.warnings);

    // Without a base directory external refs are reported, not resolved.
    let text = std::fs::read_to_string(dir.path().join("api.yaml")).unwrap();
    let doc = OpenApiDoc::parse(&text, None).unwrap();
    assert!(doc.summary().warnings.iter().any(|w| w.contains("not resolved")));
}

#[test]
fn load_file_reports_missing_files() {
    let err = OpenApiDoc::load_file(std::path::Path::new("/definitely/not/here.yaml")).unwrap_err();
    assert!(matches!(err, OpenApiError::Io(_)), "{err}");
}

#[tokio::test]
async fn load_url_sends_a_user_agent() {
    use wiremock::matchers::{header_regex, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    // Mirrors api.weather.gov: 403 unless a User-Agent is present.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/openapi.yaml"))
        .and(header_regex("user-agent", "^HttpDesk/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(PETSTORE))
        .mount(&server)
        .await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(403)).mount(&server).await;

    let doc = OpenApiDoc::load_url(&format!("{}/openapi.yaml", server.uri())).await.expect("spec loads");
    assert!(!doc.summary().operations.is_empty());
}

#[test]
fn parameter_descriptions_can_be_turned_off() {
    let opts = GenerateOptions { param_descriptions: false, ..Default::default() };
    let out = petstore().generate(&opts);
    for f in &out.files {
        let text = serialize(&f.file);
        assert!(!text.contains("# @param") && !text.contains("# @header"), "{text}");
        assert!(f.file.requests.iter().all(|r| r.query.items.iter().chain(&r.headers.items).all(|i| i.description.is_empty())));
    }
    // Request descriptions (operation summaries/descriptions) are unaffected.
    assert!(out.files.iter().any(|f| f.file.requests.iter().any(|r| !r.comments.is_empty())));
}
