import type { AuthUser } from "~/auth/types";
import type { UserRole } from "~/db/schema";

/**
 * Public `User` representation returned by the auth endpoints. `camelCase`
 * fields and RFC 3339 UTC timestamps, per the gateway-v1 contract conventions.
 */
export type UserDto = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

export function toUserDto(user: AuthUser): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
