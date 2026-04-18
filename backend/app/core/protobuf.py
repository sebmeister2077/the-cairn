"""Minimal protobuf encoder/decoder for Vintage Story gamedata blobs."""

import struct


# ─── Decoder ──────────────────────────────────────────────────────────────────

def decode_varint(data, offset):
    """Decode a protobuf varint, return (value, new_offset)."""
    result = 0
    shift = 0
    while True:
        if offset >= len(data):
            raise ValueError("Varint extends past end of data")
        byte = data[offset]
        result |= (byte & 0x7F) << shift
        offset += 1
        if (byte & 0x80) == 0:
            break
        shift += 7
    return result, offset


def parse_protobuf_fields(data):
    """Parse raw protobuf bytes into a dict of {field_number: [(wire_type, value), ...]}."""
    fields = {}
    offset = 0
    while offset < len(data):
        tag, offset = decode_varint(data, offset)
        field_number = tag >> 3
        wire_type = tag & 0x07

        if wire_type == 0:  # Varint
            value, offset = decode_varint(data, offset)
        elif wire_type == 1:  # 64-bit (fixed64 / double)
            value = data[offset:offset + 8]
            offset += 8
        elif wire_type == 2:  # Length-delimited (string, bytes, sub-message)
            length, offset = decode_varint(data, offset)
            value = data[offset:offset + length]
            offset += length
        elif wire_type == 5:  # 32-bit (fixed32 / float)
            value = data[offset:offset + 4]
            offset += 4
        else:
            break

        fields.setdefault(field_number, []).append((wire_type, value))

    return fields


def parse_protobuf_raw(data):
    """Parse protobuf bytes, preserving raw field entries in order.

    Returns a list of (field_number, wire_type, value) tuples.
    """
    entries = []
    offset = 0
    while offset < len(data):
        tag, offset = decode_varint(data, offset)
        field_number = tag >> 3
        wire_type = tag & 0x07

        if wire_type == 0:
            value, offset = decode_varint(data, offset)
        elif wire_type == 1:
            value = data[offset:offset + 8]
            offset += 8
        elif wire_type == 2:
            length, offset = decode_varint(data, offset)
            value = data[offset:offset + length]
            offset += length
        elif wire_type == 5:
            value = data[offset:offset + 4]
            offset += 4
        else:
            break

        entries.append((field_number, wire_type, value))

    return entries


# ─── Encoder ──────────────────────────────────────────────────────────────────

def encode_varint(value):
    """Encode an unsigned integer as a protobuf varint."""
    if value < 0:
        value = value + (1 << 64)
    parts = []
    while value > 0x7F:
        parts.append((value & 0x7F) | 0x80)
        value >>= 7
    parts.append(value & 0x7F)
    return bytes(parts)


def encode_tag(field_number, wire_type):
    """Encode a protobuf field tag."""
    return encode_varint((field_number << 3) | wire_type)


def encode_varint_field(field_number, value):
    """Encode a varint field (wire type 0)."""
    return encode_tag(field_number, 0) + encode_varint(value)


def encode_bytes_field(field_number, data):
    """Encode a length-delimited field (wire type 2)."""
    return encode_tag(field_number, 2) + encode_varint(len(data)) + data


def encode_double_field(field_number, value):
    """Encode a 64-bit double field (wire type 1)."""
    return encode_tag(field_number, 1) + struct.pack('<d', value)


def encode_field(field_number, wire_type, value):
    """Re-encode a parsed field entry back to bytes."""
    tag = encode_tag(field_number, wire_type)
    if wire_type == 0:
        return tag + encode_varint(value)
    elif wire_type == 1:
        return tag + value
    elif wire_type == 2:
        return tag + encode_varint(len(value)) + value
    elif wire_type == 5:
        return tag + value
    else:
        raise ValueError(f"Unknown wire type: {wire_type}")
