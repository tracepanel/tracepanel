import { type DataSource, Hint, type User } from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@tracepanel/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@tracepanel/ui/components/ui/popover";
import { useCloseOnBlur } from "@tracepanel/ui/hooks/useCloseOnBlur";
import { cn } from "@tracepanel/ui/lib/utils";
import { CheckIcon, LogOutIcon, UserRoundIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useCapability } from "./hooks";

/**
 * A narrow panel (docked right) shows its bar's actions as icons only: the outlined user button then looks like the
 * plain icon buttons beside it. So does a narrow list's toolbar row (the `brand` container) when docked at the bottom.
 */
const NARROW_ICON =
  "max-[560px]:w-[1.875rem] max-[560px]:border-transparent max-[560px]:bg-transparent max-[560px]:px-0 max-[560px]:hover:bg-[var(--dt-hover)] @max-[17rem]/brand:w-[1.875rem] @max-[17rem]/brand:border-transparent @max-[17rem]/brand:bg-transparent @max-[17rem]/brand:px-0 @max-[17rem]/brand:[&>.bar-label]:hidden";

function initials(user: User): string {
  const words = (user.name ?? user.username).split(/[\s._@-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

function Avatar({ user }: { user: User | null }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
      {user ? initials(user) : <UserRoundIcon className="size-4" />}
    </span>
  );
}

function Role({ user }: { user: User }) {
  const role = user.is_superuser ? "superuser" : user.is_staff ? "staff" : null;
  return role ? (
    <span className="rounded border border-brand/30 bg-brand-soft px-1.5 py-0.5 text-2xs text-brand">{role}</span>
  ) : null;
}

/**
 * Who this browser is logged in as, and a popover under the button to become someone else: development only, from this machine.
 * Shown only where the backend offers it (Django with django.contrib.auth and sessions). After a switch the page
 * reloads (`onSwitched`), so it renders for the new user.
 */
/** The switcher where the app behind the console offers one (Django); nothing elsewhere, and nobody asked. */
export function SwitchUser(props: { source: DataSource; onSwitched: () => void }) {
  return useCapability(props.source, "users") ? <UserSwitcher {...props} /> : null;
}

// What the user button says: its name and hint, nobody logged in or someone.
const NOBODY = {
  label: "Set user",
  title: "Set user",
  detail: "Logs this browser in as any user, without a password. Development only.",
};
function acting(user: User): typeof NOBODY {
  const label = `Acting as ${user.username}`;
  return { label, title: `${label} · click to change`, detail: "Development only." };
}

/** The popover's button, one size whoever is logged in: a name would stretch the toolbar, so it is the hint's. */
function UserTrigger({ current }: { current: User | null }) {
  const says = current ? acting(current) : NOBODY;
  return (
    <Hint title={says.title} detail={says.detail}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={says.label}
          className={cn("h-7.5 shrink-0 gap-1.5 px-2 text-sm font-normal shadow-none", NARROW_ICON)}
        >
          <UserIcon set={current !== null} />
          <span className="bar-label">Set user</span>
        </Button>
      </PopoverTrigger>
    </Hint>
  );
}

/** The user icon: muted with nobody logged in, lit with a dot at its corner while someone is. */
function UserIcon({ set }: { set: boolean }) {
  return (
    <span className="relative grid place-items-center">
      <UserRoundIcon className={set ? "text-brand" : "text-muted-foreground"} />
      {set ? (
        <span
          data-testid="user-set-dot"
          className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-brand ring-2 ring-background"
        />
      ) : null}
    </span>
  );
}

function UserSwitcher({ source, onSwitched }: { source: DataSource; onSwitched: () => void }) {
  const [current, setCurrent] = useState<User | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  useCloseOnBlur(open, closeMenu);

  useEffect(() => {
    source.currentUser().then(setCurrent, () => setCurrent(undefined));
  }, [source]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => source.searchUsers(query).then(setUsers, () => setUsers([])), 150);
    return () => window.clearTimeout(timer);
  }, [open, query, source]);

  // Hidden where switching isn't available (no auth app, another machine, turned off).
  if (current === undefined) return null;

  const pick = (id: string | null) => {
    setError(null);
    source.switchUser(id).then(
      (user) => {
        setCurrent(user);
        setOpen(false);
        onSwitched();
      },
      (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery("");
          setError(null);
        }
        setOpen(next);
      }}
    >
      <UserTrigger current={current} />
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-[22.5rem] flex-col overflow-hidden p-0"
      >
        <div className="grid gap-1 border-b px-4 pt-4 pb-3">
          <p className="text-base font-semibold">View this site as</p>
          <p className="text-xs text-muted-foreground">
            Logs this browser in as the user, without a password. Development only.
          </p>
        </div>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Avatar user={current} />
          <span className="grid min-w-0 flex-1">
            <span className="text-xs text-muted-foreground">Now</span>
            <span className="truncate font-medium">{current ? current.username : "Anonymous"}</span>
          </span>
          {current ? <Role user={current} /> : null}
          {current ? (
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-sm" onClick={() => pick(null)}>
              <LogOutIcon />
              Log out
            </Button>
          ) : null}
        </div>
        <Command shouldFilter={false} className="min-h-0 flex-1 rounded-none">
          <CommandInput
            autoFocus={true}
            placeholder="Username, name or email…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-none min-h-0 flex-1">
            {users === null ? null : <CommandEmpty>No users match.</CommandEmpty>}
            <CommandGroup>
              {(users ?? []).map((user) => (
                <CommandItem key={user.id} value={user.id} onSelect={() => pick(user.id)} className="gap-3 py-2">
                  <Avatar user={user} />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate font-medium">{user.username}</span>
                    {user.name || user.email ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {[user.name, user.email].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </span>
                  <Role user={user} />
                  {current?.id === user.id ? <CheckIcon className="size-4 text-brand" strokeWidth={3} /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {error ? <p className="border-t px-4 py-2 text-sm text-error">{error}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
