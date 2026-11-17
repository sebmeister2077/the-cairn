import type { Locale } from "@/lib/i18n";
import type { ComponentType } from "react";
import { AddingTranslocatorsWithContributeTLsPost } from "./AddingTranslocatorsWithContributeTLsPost";
import { AddingTranslocatorsWithContributeTLsPostRu } from "./AddingTranslocatorsWithContributeTLsPost.ru";
import { ContributingElkWalkableRoadsPost } from "./ContributingElkWalkableRoadsPost";
import { ContributingElkWalkableRoadsPostRu } from "./ContributingElkWalkableRoadsPost.ru";
import { ContributingToTopsMapPost } from "./ContributingToTopsMapPost";
import { ContributingToTopsMapPostRu } from "./ContributingToTopsMapPost.ru";
import { ManagingLandmarksPost } from "./ManagingLandmarksPost";
import { ManagingLandmarksPostRu } from "./ManagingLandmarksPost.ru";
import { SubmittingTranslocatorScreenshotsPost } from "./SubmittingTranslocatorScreenshotsPost";
import { SubmittingTranslocatorScreenshotsPostRu } from "./SubmittingTranslocatorScreenshotsPost.ru";
import { BLOG_POSTS, type BlogPostRecord } from "./post-meta";

export interface BlogPostMeta {
    slug: string;
    title: string;
    excerpt: string;
    date: string; // ISO yyyy-mm-dd
    readingMinutes: number;
    tags: string[];
    Component: ComponentType;
}

type PostComponents = { en: ComponentType } & Partial<Record<Locale, ComponentType>>;

// Post bodies by slug. Locales without a translated body use the English one.
const POST_COMPONENTS: Record<string, PostComponents> = {
    "contributing-elk-walkable-roads": {
        en: ContributingElkWalkableRoadsPost,
        ru: ContributingElkWalkableRoadsPostRu,
    },
    "managing-landmarks": {
        en: ManagingLandmarksPost,
        ru: ManagingLandmarksPostRu,
    },
    "submitting-translocator-screenshots": {
        en: SubmittingTranslocatorScreenshotsPost,
        ru: SubmittingTranslocatorScreenshotsPostRu,
    },
    "adding-translocators-using-waypoints": {
        en: AddingTranslocatorsWithContributeTLsPost,
        ru: AddingTranslocatorsWithContributeTLsPostRu,
    },
    "contributing-to-the-tops-map": {
        en: ContributingToTopsMapPost,
        ru: ContributingToTopsMapPostRu,
    },
};

function toPostMeta(post: BlogPostRecord, locale: Locale): BlogPostMeta {
    const components = POST_COMPONENTS[post.slug];
    return {
        slug: post.slug,
        date: post.date,
        readingMinutes: post.readingMinutes,
        ...post.translations[locale],
        Component: components[locale] ?? components.en,
    };
}

export function getBlogPosts(locale: Locale): BlogPostMeta[] {
    return BLOG_POSTS.map((post) => toPostMeta(post, locale));
}

export function getPostBySlug(locale: Locale, slug: string): BlogPostMeta | undefined {
    const post = BLOG_POSTS.find((entry) => entry.slug === slug);
    return post ? toPostMeta(post, locale) : undefined;
}
