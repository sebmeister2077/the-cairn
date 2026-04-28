import type { ComponentType } from "react";
import { ContributingToTopsMapPost } from "./ContributingToTopsMapPost";

export interface BlogPostMeta {
    slug: string;
    title: string;
    excerpt: string;
    date: string; // ISO yyyy-mm-dd
    readingMinutes: number;
    tags: string[];
    Component: ComponentType;
}

// Posts are listed newest-first.
export const BLOG_POSTS: BlogPostMeta[] = [
    {
        slug: "contributing-to-the-tops-map",
        title: "Contributing to the TOPS Online Map",
        excerpt:
            "A friendly walkthrough of how player-uploaded map cache files become tiles on the shared TOPS map — and how to make a clean contribution that gets approved.",
        date: "2026-04-28",
        readingMinutes: 7,
        tags: ["guide", "multiplayer", "tops-map"],
        Component: ContributingToTopsMapPost,
    },
];

export function getPostBySlug(slug: string): BlogPostMeta | undefined {
    return BLOG_POSTS.find((p) => p.slug === slug);
}
