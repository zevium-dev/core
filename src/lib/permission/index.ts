export type Permissions = Partial<Record<ResourceId, PermissionKeys>>;

type EndpointKey = {} & string;
type PermissionKeys = Array<EndpointKey>;
type ResourceId = {} & string;
