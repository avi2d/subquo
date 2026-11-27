# Vision

Every paid AI coding account a person names reports how much it has left, in one file any tool can read.
It serves people who run agent work across several paid subscriptions and pick an account before each job.
It owns the read of each named account's quota windows, and the one snapshot that holds them.

## Report, never route

- It allows a reader to see each window's percent left and reset time.
  It forbids subquo picking an account, a floor or a spend order.
  Each reading tool keeps its own rules.

## Read a login, never own it

- It allows reading a login in memory and asking the vendor's tool to renew it.
  It forbids writing or switching a login and leaves sign-in to you.

## No secret leaves the read

- It allows only listed fields and safe error codes in output.
  It forbids a token, a raw vendor response or a login path in the snapshot, errors, logs or test files.
  A failed read gives less detail.

## Unknown is never full

- It allows a fresh reading as evidence for a pick.
  It forbids counting a stale, missing or unchecked reading as room.
  A pick may pass over an account that still has room.

## Every account is named

- It allows only the accounts an explicit account list names.
  It forbids guessing an account from a default login or reading another account's login in its place.
  Each machine's owner writes the list by hand.

## A read never waits on a vendor

- It allows `subquo read` to print the last complete snapshot without the network.
  It forbids a read that waits on a vendor, a lock or a password prompt.
  Readings may be as old as the refresh interval.

## Scope

- Signing in and renewing a login belong to each vendor's own tool, and subquo only reads the login that tool saved.
- Picking an account, its floors and its spend order belong to the scheduler or dashboard that reads the snapshot.
- Session token counts and cost reports belong to usage trackers, and subquo reads only what a subscription has left.
- Running the refresh on a timer belongs to the machine's own scheduler, and subquo runs no service of its own.

A change aligns when it makes one account's reading more truthful about what is left, how old it is or why it is missing.
A change should be resisted when it makes subquo keep a secret, start a login or decide for the tools that read it.
