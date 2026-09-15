// Application-scoped directory lookup. No user OAuth or cross-application IDs.
export type Contact = { openId: string; name: string; department?: string };
export type ContactResult = { contacts: Contact[]; incomplete: boolean };
export type DirectoryRead = (route: string) => Promise<any>;
export async function findContacts(
  read: DirectoryRead,
  query: string,
): Promise<ContactResult> {
  if (!query.trim()) throw new Error("invalid_contact_query");
  const result = await listContacts(read, query, 0, 10);
  return {
    contacts: result.contacts,
    incomplete: result.incomplete || result.nextOffset !== null,
  };
}
export async function listContacts(
  read: DirectoryRead,
  query = "",
  offset = 0,
  limit = 50,
) {
  query = query.trim();
  if (
    query.length > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 5000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("invalid_contact_query");
  let requests = 0;
  const get = async (route: string) => {
    if (++requests > 100) throw new Error("directory_limit");
    const result = await read(route);
    if (result.code !== 0 || !result.data)
      throw new Error("directory_response_invalid");
    return result.data;
  };
  const contacts = new Map<string, Contact>();
  const add = (u: any, department?: string) => {
    if (u?.open_id && (typeof u.name !== "string" || !u.name.trim()))
      throw new Error("directory_name_permission_required");
    if (
      !u ||
      !/^ou_[A-Za-z0-9_-]{1,190}$/.test(u.open_id ?? "") ||
      typeof u.name !== "string"
    )
      return;
    if (u.status?.is_resigned || u.status?.is_frozen) return;
    if (
      u.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ||
      u.en_name?.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ||
      u.open_id === query
    )
      contacts.set(u.open_id, {
        openId: u.open_id,
        name: u.name.slice(0, 100),
        department,
      });
  };
  if (/^ou_[A-Za-z0-9_-]{1,190}$/.test(query)) {
    add(
      (
        await get(
          `contact/v3/users/${encodeURIComponent(query)}?user_id_type=open_id`,
        )
      ).user,
    );
    return {
      contacts: [...contacts.values()].slice(offset, offset + limit),
      incomplete: false,
      nextOffset: null,
    };
  }
  const pages = async (route: string, consume: (data: any) => void) => {
    let token = "";
    const visited = new Set<string>();
    do {
      if (visited.has(token)) throw new Error("directory_response_invalid");
      visited.add(token);
      const data = await get(
        route +
          (route.includes("?") ? "&" : "?") +
          "page_size=100" +
          (token ? `&page_token=${encodeURIComponent(token)}` : ""),
      );
      consume(data);
      if (!data.has_more) break;
      if (typeof data.page_token !== "string" || !data.page_token)
        throw new Error("directory_response_invalid");
      token = data.page_token;
    } while (true);
  };
  let incomplete = false;
  const users = new Set<string>();
  const departments = new Map<string, string>();
  try {
    await pages(
      "contact/v3/scopes?user_id_type=open_id&department_id_type=open_department_id",
      (data) => {
        for (const id of data.user_ids ?? []) users.add(id);
        for (const id of data.department_ids ?? [])
          departments.set(id, id === "0" ? "" : id);
        if (data.group_ids?.length) incomplete = true;
      },
    );
    for (const id of users)
      add(
        (
          await get(
            `contact/v3/users/${encodeURIComponent(id)}?user_id_type=open_id`,
          )
        ).user,
      );
    // Map iteration also visits discovered children; a Set prevents cycles and overlap.
    const visited = new Set<string>();
    for (const [id, name] of departments) {
      if (visited.has(id)) continue;
      visited.add(id);
      await pages(
        `contact/v3/users/find_by_department?department_id=${encodeURIComponent(id)}&user_id_type=open_id&department_id_type=open_department_id`,
        (data) => {
          for (const user of data.items ?? []) add(user, name);
        },
      );
      await pages(
        `contact/v3/departments/${encodeURIComponent(id)}/children?department_id_type=open_department_id&fetch_child=false`,
        (data) => {
          for (const d of data.items ?? [])
            if (
              typeof d.open_department_id === "string" &&
              !departments.has(d.open_department_id)
            )
              departments.set(
                d.open_department_id,
                String(d.name ?? "").slice(0, 100),
              );
        },
      );
    }
  } catch (e) {
    if (!(e instanceof Error && e.message === "directory_limit")) throw e;
    incomplete = true;
  }
  const ordered = [...contacts.values()];
  return {
    contacts: ordered.slice(offset, offset + limit),
    incomplete,
    nextOffset: ordered.length > offset + limit ? offset + limit : null,
  };
}
