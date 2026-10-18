// Dependency-free HTML sanitizer for rendering untrusted, user-authored rich
// text (e.g. Vintage Story parchment/book contents carried on auction listings).
//
// Safety model: the input is parsed with `DOMParser` into an INERT document —
// it is not connected to a browsing context, so scripts never run and no
// subresources (images, etc.) are ever fetched, meaning `onerror`/`onload`
// handlers can't fire during parsing. We then rebuild the tree from scratch,
// copying across ONLY an allowlist of tags and attributes and rejecting unsafe
// URL schemes. Anything not explicitly allowed is dropped. Because the output
// is reconstructed (never the original nodes), no attribute or tag we didn't
// deliberately re-create can survive. The project ships no Content-Security-
// Policy, so this sanitization is the primary XSS defense for this content.

const ALLOWED_TAGS = new Set([
    "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "mark",
    "br", "p", "div", "span", "font",
    "ul", "ol", "li",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "code", "pre", "hr", "small", "sub", "sup",
]);

// Tags whose entire subtree must be discarded (never unwrapped to their text).
const DROP_TAGS = new Set([
    "script", "style", "iframe", "object", "embed", "link", "meta", "base",
    "form", "input", "button", "textarea", "svg", "math", "template", "noscript",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
    a: new Set(["href"]),
    font: new Set(["color", "face", "size"]),
    span: new Set(["color"]),
};

/** Return the URL only when it uses a benign scheme, else null. Blocks
 * `javascript:`, `data:`, `vbscript:` and other script-capable schemes. */
function safeUrl(raw: string): string | null {
    const value = raw.trim();
    if (value === "") return null;
    // Reject any explicit scheme that isn't http/https/mailto. Relative URLs and
    // anchors (no ":") are allowed through.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
    if (scheme && !/^(https?|mailto)$/i.test(scheme[1])) return null;
    return value;
}

function sanitizeNode(node: Node): Node | null {
    if (node.nodeType === Node.TEXT_NODE) {
        return document.createTextNode(node.textContent ?? "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (DROP_TAGS.has(tag)) return null;

    // Unknown-but-not-dangerous tag: unwrap it, keeping its sanitized children.
    if (!ALLOWED_TAGS.has(tag)) {
        const frag = document.createDocumentFragment();
        for (const child of Array.from(el.childNodes)) {
            const clean = sanitizeNode(child);
            if (clean) frag.appendChild(clean);
        }
        return frag;
    }

    const out = document.createElement(tag);
    const allowed = ALLOWED_ATTRS[tag];
    if (allowed) {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (!allowed.has(name)) continue;
            if (name === "href") {
                const url = safeUrl(attr.value);
                if (url) out.setAttribute("href", url);
            } else {
                out.setAttribute(name, attr.value);
            }
        }
    }
    if (tag === "a") {
        out.setAttribute("target", "_blank");
        out.setAttribute("rel", "noopener noreferrer nofollow");
    }

    for (const child of Array.from(el.childNodes)) {
        const clean = sanitizeNode(child);
        if (clean) out.appendChild(clean);
    }
    return out;
}

/** Sanitize an untrusted HTML string into a safe HTML string suitable for
 * `dangerouslySetInnerHTML`. Returns only allowlisted tags/attributes. */
export function sanitizeHtml(dirty: string): string {
    const doc = new DOMParser().parseFromString(dirty, "text/html");
    const container = document.createElement("div");
    for (const node of Array.from(doc.body.childNodes)) {
        const clean = sanitizeNode(node);
        if (clean) container.appendChild(clean);
    }
    return container.innerHTML;
}

/** Heuristic: does this string appear to contain HTML markup (a tag)? Used to
 * decide between plain-text rendering and sanitized rich-text rendering. */
export function looksLikeHtml(text: string): boolean {
    return /<[a-z!/][\s\S]*?>/i.test(text);
}
