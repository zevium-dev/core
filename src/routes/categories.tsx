import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";

import ImageCard from "~/components/ui/image-card";
import { Input } from "~/components/ui/input";
import { Pagination } from "~/components/ui/pagination";

export const Route = createFileRoute("/categories")({ component: CategoriesPage });

interface Category {
	id: string;
	imageUrl: string;
	title: string;
}

// Placeholder data until API backend exists.
const ALL_CATEGORIES: Array<Category> = Array.from({ length: 30 }).map((_, i) => ({
	id: String(i + 1),
	imageUrl: `https://picsum.photos/seed/cat-${i + 1}/400/300`,
	title: `Category ${i + 1}`,
}));

const PAGE_SIZE = 18;

function CategoriesPage() {
	const [search, setSearch] = React.useState<string>("");
	const [page, setPage] = React.useState<number>(1);

	const filtered = React.useMemo(() => {
		if (!search) return ALL_CATEGORIES;
		const s = search.toLowerCase();
		return ALL_CATEGORIES.filter((c) => c.title.toLowerCase().includes(s));
	}, [search]);

	const total = filtered.length;
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const currentPage = Math.min(page, totalPages);
	const start = (currentPage - 1) * PAGE_SIZE;
	const items = filtered.slice(start, start + PAGE_SIZE);

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setPage(1);
	};

	return (
		<div className="mx-auto w-full max-w-6xl px-4 py-8">
			<h1 className="mb-6 text-3xl font-heading text-foreground">API Categories</h1>

			<form className="mb-6" onSubmit={onSubmit} role="search">
				<Input
					aria-label="Search categories"
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search categories..."
					value={search}
				/>
			</form>

			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
					{items.map((cat) => (
						<ImageCard caption={cat.title} className="w-full" imageUrl={cat.imageUrl} key={cat.id} />
					))}
				{items.length === 0 && (
					<div className="text-foreground/70 col-span-full py-8 text-center">No categories found.</div>
				)}
			</div>

						<Pagination
				className="mt-8"
							onPageChange={(p) => setPage(p)}
				page={currentPage}
				pageSize={PAGE_SIZE}
				total={total}
			/>
		</div>
	);
}

