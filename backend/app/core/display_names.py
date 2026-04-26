"""Display name generation for the account system.

Generates Reddit-style names of the form `Adjective-Noun-####`.

The forbidden-substring filter is intentionally crude — it only screens for
the most common slurs/spam patterns. Bad names that slip through can be
flagged by users via the in-game name flagging flow and admins can rename
them with `/admin/users/{key}/regenerate-name`.
"""

from __future__ import annotations

import random
from typing import List, Optional

# Curated word lists. Kept short to make collisions cheap to resolve.
# Themes are loosely aligned with Vintage Story (crafting/exploration/wilderness).
ADJECTIVES: List[str] = [
    "Ancient", "Arctic", "Autumn", "Bold", "Brave", "Bright", "Bronze",
    "Calm", "Clever", "Copper", "Crimson", "Crystal", "Cunning", "Daring",
    "Deep", "Diligent", "Distant", "Echoing", "Ember", "Emerald", "Endless",
    "Fearless", "Fierce", "Flint", "Flying", "Forgotten", "Frosty", "Gentle",
    "Gilded", "Glowing", "Golden", "Granite", "Green", "Hardy", "Hidden",
    "Howling", "Humble", "Icy", "Ivory", "Jade", "Keen", "Lone", "Loyal",
    "Lucky", "Lunar", "Marble", "Merry", "Mighty", "Misty", "Moonlit",
    "Nimble", "Noble", "Northern", "Obsidian", "Patient", "Pine",
    "Quiet", "Quick", "Radiant", "Rare", "Restless", "Roaming", "Rocky",
    "Rugged", "Rusty", "Sable", "Sage", "Seeking", "Serene", "Shadow",
    "Sharp", "Silent", "Silver", "Sleeping", "Smoky", "Solar", "Solid",
    "Southern", "Stalwart", "Steady", "Stormy", "Strong", "Sturdy",
    "Sunlit", "Swift", "Tall", "Thoughtful", "Thunder", "Tidal", "Twilight",
    "Vagrant", "Velvet", "Vivid", "Wandering", "Weary", "Whispering",
    "Wild", "Windy", "Winter", "Wise", "Wooden", "Zealous",
]

NOUNS: List[str] = [
    "Anvil", "Apprentice", "Archer", "Artisan", "Aurochs", "Badger",
    "Beaver", "Bison", "Bramble", "Cairn", "Camp", "Canoe", "Carver",
    "Caver", "Chisel", "Cinder", "Clay", "Cloak", "Cobbler", "Compass",
    "Cooper", "Crow", "Delver", "Drifter", "Elk", "Ember", "Explorer",
    "Falcon", "Farmer", "Ferret", "Finder", "Flame", "Fletcher", "Forager",
    "Forge", "Fox", "Frost", "Furrier", "Glade", "Glider", "Granite",
    "Guide", "Hammer", "Harbor", "Hawk", "Healer", "Hearth", "Helm",
    "Herald", "Hermit", "Hollow", "Horizon", "Hunter", "Hut", "Ingot",
    "Iron", "Journeyer", "Kettle", "Lantern", "Ledger", "Lichen", "Lodge",
    "Lynx", "Mason", "Meadow", "Miner", "Mortar", "Mountain", "Nomad",
    "Oak", "Otter", "Outpost", "Paddler", "Pathfinder", "Pelt", "Pine",
    "Pioneer", "Pioneer", "Plover", "Potter", "Prospector", "Quarry",
    "Quill", "Raft", "Ranger", "Raven", "Reed", "Rider", "Rivulet",
    "Roamer", "Rover", "Sage", "Scholar", "Scout", "Seeker", "Settler",
    "Shaper", "Shepherd", "Sickle", "Sleeper", "Smith", "Sojourner",
    "Sparrow", "Spire", "Stoat", "Stonemason", "Strider", "Tanner",
    "Thatcher", "Tinker", "Torch", "Tracker", "Trader", "Trapper",
    "Traveler", "Tundra", "Vagabond", "Voyager", "Wanderer", "Warden",
    "Watcher", "Waterfall", "Weaver", "Whittler", "Wolf", "Woodsman",
    "Wright", "Yeoman",
]


# Lowercased substrings that disqualify a generated name. Trying to keep this
# short — extensive profanity lists belong in a separate config file.
FORBIDDEN_SUBSTRINGS: List[str] = [
    "admin", "moderator", "system", "official", "staff", "owner",
    "support", "vintagestory", "anuke",
    # Crude profanity blocklist (intentionally minimal):
    "nazi", "hitler",
]


def generate_display_name(rng: Optional[random.Random] = None) -> str:
    """Return a candidate display name. May still collide; caller must check uniqueness."""
    r = rng or random
    adj = r.choice(ADJECTIVES)
    noun = r.choice(NOUNS)
    number = r.randint(0, 9999)
    return f"{adj}-{noun}-{number:04d}"


def is_forbidden_name(name: str) -> bool:
    lower = name.lower()
    return any(bad in lower for bad in FORBIDDEN_SUBSTRINGS)


def pick_unique_display_name(
    is_taken,
    *,
    max_attempts: int = 50,
    rng: Optional[random.Random] = None,
) -> str:
    """Generate a name that passes ``is_forbidden_name`` and ``is_taken(name) is False``.

    Falls back to a timestamp-suffixed name after ``max_attempts`` tries to
    guarantee progress in extreme edge cases.
    """
    for _ in range(max_attempts):
        candidate = generate_display_name(rng)
        if is_forbidden_name(candidate):
            continue
        if not is_taken(candidate):
            return candidate
    # Last-ditch fallback — extremely unlikely to collide.
    import time
    return f"{generate_display_name(rng)}-{int(time.time())}"
