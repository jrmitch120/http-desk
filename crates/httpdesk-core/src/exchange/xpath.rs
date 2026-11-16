//! XPath 1.0 into an XML body, the way VS Code REST Client reads one (its `xpath`
//! package over `xmldom`), on `sxd-xpath`. Only [`first`] is used outside.

use sxd_document::dom::{ChildOfElement, Element};
use sxd_xpath::nodeset::Node;
use sxd_xpath::{Context, Factory, Value};

/// What `path` reads from the XML document `text`, as REST Client inserts it:
/// a string, number or boolean result as itself; of a node-set, the first node in
/// document order: an element's content as XML (`<a><b>1</b></a>` → `<b>1</b>`),
/// the document's root element as XML, or any other node's value (an attribute's,
/// a text node's). `Err` says why it reads nothing.
pub(super) fn first(text: &str, path: &str) -> Result<String, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let package = sxd_document::parser::parse(text).map_err(|e| format!("the body isn't valid XML: {e}"))?;
    let document = package.as_document();
    let xpath = match Factory::new().build(path) {
        Ok(Some(xpath)) => xpath,
        Ok(None) | Err(_) => return Err(format!("`{path}` isn't a valid XPath")),
    };
    let value = xpath.evaluate(&Context::new(), document.root()).map_err(|e| format!("`{path}`: {e}"))?;
    let Value::Nodeset(nodes) = value else { return Ok(value.into_string()) };
    let node = nodes.document_order_first().ok_or_else(|| format!("`{path}` matches nothing"))?;
    Ok(match node {
        Node::Root(root) => {
            let mut out = String::new();
            for child in root.children() {
                if let Some(element) = child.element() {
                    write_element(element, &mut out);
                }
            }
            out
        }
        Node::Element(element) => {
            let mut out = String::new();
            write_children(element, &mut out);
            out
        }
        Node::Text(text) => {
            // The parser splits text at references (`Hi &amp; bye` is three nodes);
            // in XPath's model, as in REST Client's DOM, it is one.
            let run = |siblings: Vec<ChildOfElement>| -> Vec<String> {
                siblings.into_iter().map_while(|s| s.text().map(|t| t.text().to_string())).collect()
            };
            let mut before = run(text.preceding_siblings().into_iter().rev().collect());
            before.reverse();
            [before.concat(), text.text().to_string(), run(text.following_siblings()).concat()].concat()
        }
        other => other.string_value(),
    })
}

/// `element`'s children as XML.
fn write_children(element: Element, out: &mut String) {
    for child in element.children() {
        match child {
            ChildOfElement::Element(e) => write_element(e, out),
            ChildOfElement::Text(t) => escape(t.text(), false, out),
            ChildOfElement::Comment(c) => {
                out.push_str("<!--");
                out.push_str(c.text());
                out.push_str("-->");
            }
            ChildOfElement::ProcessingInstruction(pi) => {
                out.push_str("<?");
                out.push_str(pi.target());
                if let Some(value) = pi.value() {
                    out.push(' ');
                    out.push_str(value);
                }
                out.push_str("?>");
            }
        }
    }
}

/// `element` as XML, with its prefixes as written and the namespaces it declares.
fn write_element(element: Element, out: &mut String) {
    let name = qualified(element.preferred_prefix(), element.name().local_part());
    out.push('<');
    out.push_str(&name);
    if let Some(uri) = element.default_namespace_uri() {
        attribute("xmlns", uri, out);
    }
    let inherited = element.parent().and_then(|p| p.element()).map(|p| p.namespaces_in_scope()).unwrap_or_default();
    for ns in element.namespaces_in_scope() {
        let declared_above = inherited.iter().any(|i| i.prefix() == ns.prefix() && i.uri() == ns.uri());
        if !declared_above && ns.prefix() != "xml" {
            attribute(&format!("xmlns:{}", ns.prefix()), ns.uri(), out);
        }
    }
    for attr in element.attributes() {
        attribute(&qualified(attr.preferred_prefix(), attr.name().local_part()), attr.value(), out);
    }
    if element.children().is_empty() {
        out.push_str("/>");
        return;
    }
    out.push('>');
    write_children(element, out);
    out.push_str("</");
    out.push_str(&name);
    out.push('>');
}

fn qualified(prefix: Option<&str>, local: &str) -> String {
    prefix.map_or_else(|| local.to_string(), |p| format!("{p}:{local}"))
}

fn attribute(name: &str, value: &str, out: &mut String) {
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    escape(value, true, out);
    out.push('"');
}

/// `text` with the characters XML reserves escaped (`"` too `in_attribute`).
fn escape(text: &str, in_attribute: bool, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if in_attribute => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
}
