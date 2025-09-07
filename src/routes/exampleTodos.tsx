import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { api } from "~/../convex/_generated/api";

export const Route = createFileRoute("/exampleTodos")({
  component: ExampleTodoList,
  loader: async ({ context }) => {
    return context.convexBrowserClient.query(api.exampleTodo.getList, { paginationOpts: { cursor: null } });
  },
});

function ExampleTodoList() {
  const initialData = Route.useLoaderData();

  const exampleTodosGetListQuery = useQuery({
    ...convexQuery(api.exampleTodo.getList, { paginationOpts: { cursor: null } }),
    initialData,
  });

  const exampleTodosToggleStatusMutation = useMutation({
    mutationFn: useConvexMutation(api.exampleTodo.toggleStatus),
  });
  // or simply
  // const exampleTodosToggleStatusMutation = useConvexMutation(api.exampleTodo.toggleStatus);

  const exampleTodosCreateMutation = useConvexMutation(api.exampleTodo.create);

  return (
    <div>
      {exampleTodosGetListQuery.data?.items.map(({ _id, status, title }) => (
        <div key={_id}>
          <h3>{title}</h3>
          <button onClick={() => exampleTodosToggleStatusMutation.mutate({ id: _id })} type="button">
            Status: {status}
          </button>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const formData = new FormData(e.currentTarget);
          const title = formData.get("title");
          if (typeof title !== "string") return;
          if (!title.trim()) return;
          void exampleTodosCreateMutation({ title });
        }}
      >
        <input name="title" placeholder="New Todo" />
        <button type="submit">Create</button>
      </form>
    </div>
  );
}
