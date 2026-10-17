import busboy from 'busboy';

/**
 * The fields the JustDial lead spec sends. Display order + human labels.
 * Anything not listed here is still kept and shown in the "all fields" table.
 */
export const KNOWN_FIELDS = [
    ['leadid', 'Lead ID'],
    ['prefix', 'Prefix'],
    ['name', 'Name'],
    ['mobile', 'Mobile'],
    ['phone', 'Phone'],
    ['email', 'Email'],
    ['category', 'Category'],
    ['company', 'Company'],
    ['area', 'Area'],
    ['brancharea', 'Branch Area'],
    ['city', 'City'],
    ['pincode', 'Pincode'],
    ['branchpin', 'Branch Pincode'],
    ['leadtype', 'Lead Type'],
    ['date', 'Date'],
    ['time', 'Time'],
    ['parentid', 'Parent ID'],
    ['dncmobile', 'DNC Mobile'],
    ['dncphone', 'DNC Phone'],
];

/**
 * Parse a multipart/form-data request body (Postman "form-data").
 */
export function parseMultipart(req) {
    return new Promise((resolve) => {
        const fields = {};

        let bb;
        try {
            bb = busboy({ headers: req.headers });
        } catch {
            return resolve(fields);
        }

        bb.on('field', (name, value) => {
            fields[name] = value;
        });

        // Files are irrelevant for a lead - drain them so the stream finishes.
        bb.on('file', (_name, stream) => stream.resume());
        bb.on('close', () => resolve(fields));
        bb.on('error', () => resolve(fields));

        req.pipe(bb);
    });
}

function tryJson(text) {
    try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
        /* not JSON */
    }
    return null;
}

function parseQueryString(text) {
    const out = {};
    if (!text) return out;

    try {
        new URLSearchParams(text).forEach((value, key) => {
            out[key] = value;
        });
    } catch {
        /* ignore */
    }

    return out;
}

/**
 * Decode a raw body no matter how the sender formatted it:
 * JSON, text/plain JSON, shell-escaped JSON ({"leadid":"X"}) or a query string.
 */
export function parseBody(body, contentType = '') {
    const text = String(body ?? '').trim();
    if (!text) return null;

    const type = String(contentType).toLowerCase();

    // 1. Proper JSON.
    const asJson = tryJson(text);
    if (asJson) return asJson;

    // 2. form-urlencoded or a bare query string.
    if (type.includes('urlencoded') || text.includes('=')) {
        const asQuery = parseQueryString(text);
        if (Object.keys(asQuery).length) return asQuery;
    }

    // 3. Shell/Postman escaped JSON, e.g. {\"leadid\":\"JD-1\"}
    const repaired = text.replace(/\\"/g, '"').replace(/\\'/g, "'");
    const asRepaired = tryJson(repaired) ?? tryJson(repaired.replace(/^['"]|['"]$/g, ''));
    if (asRepaired) return asRepaired;

    return null;
}

function flattenValue(value) {
    if (Array.isArray(value)) return value[0];
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return '';
    return value;
}

/**
 * Merge query string + body into a single flat object.
 */
export function collectInput({ url, raw, contentType, multipart }) {
    let data = {};

    url.searchParams.forEach((value, key) => {
        data[key] = value;
    });

    const fromBody = multipart ?? parseBody(raw, contentType);
    if (fromBody) data = { ...data, ...fromBody };

    const flat = {};
    for (const [key, value] of Object.entries(data)) {
        flat[key] = flattenValue(value);
    }

    return flat;
}

/**
 * Case-insensitive lookup. JustDial's spec is inconsistent about casing
 * ("Area" vs "area") and sometimes appends a stray ">>" to values.
 */
export function pick(data, key) {
    let value;

    if (Object.prototype.hasOwnProperty.call(data, key)) {
        value = data[key];
    } else {
        const wanted = key.toLowerCase();
        for (const [k, v] of Object.entries(data)) {
            if (k.toLowerCase() === wanted) {
                value = v;
                break;
            }
        }
    }

    if (value === null || value === undefined) return '';

    return String(value).replace(/>>/g, '').trim();
}

/**
 * Turn the raw payload into the shape the email template uses.
 */
export function normalize(data) {
    const leadId = pick(data, 'leadid');
    const prefix = pick(data, 'prefix');
    const name = pick(data, 'name');
    const mobile = pick(data, 'mobile');
    const phone = pick(data, 'phone');
    const area = pick(data, 'area');
    const branchArea = pick(data, 'brancharea');
    const city = pick(data, 'city');
    const pincode = pick(data, 'pincode') || pick(data, 'branchpin');

    return {
        leadId,
        prefix,
        name,
        mobile,
        phone,
        email: pick(data, 'email'),
        category: pick(data, 'category'),
        company: pick(data, 'company'),
        city,
        area,
        branchArea,
        pincode,
        leadType: pick(data, 'leadtype'),
        date: pick(data, 'date'),
        time: pick(data, 'time'),

        fullName: [prefix, name].filter(Boolean).join(' ') || 'JustDial Lead',
        displayPhone: mobile || phone,
        address: [area, branchArea, city, pincode].filter(Boolean).join(', '),
        receivedAt: new Date(),
        raw: data,
    };
}

/**
 * A call with none of these is not a lead at all.
 */
export function isUsable(lead) {
    return Boolean(lead.leadId || lead.name || lead.mobile || lead.phone);
}
