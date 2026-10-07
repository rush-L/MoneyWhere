-- Phase 10: realtime invalidation for transactions (expense, income and transfer rows alike).
-- Private Broadcast on topic 'wallet:<wallet_id>', fired by a trigger. Payload is only the operation: clients
-- treat it as "reload", never as data. postgres_changes is NOT used: it applies no RLS to DELETE and cannot
-- filter DELETE by wallet, so every subscriber would see other wallets' deletes.

create function public.notify_transaction_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('op', tg_op),
      'tx_changed',
      'wallet:' || coalesce(new.wallet_id, old.wallet_id)::text,
      true
    );
  exception when others then
    raise warning 'transactions realtime notify failed: %', sqlerrm; -- Realtime is optional; never fail the money write
  end;
  return null;
end;
$$;
revoke execute on function public.notify_transaction_change() from public, anon, authenticated;

create trigger transactions_notify
  after insert or update or delete on public.transactions
  for each row execute function public.notify_transaction_change();

-- Only wallet members may RECEIVE on their wallet's topic. No insert policy: clients cannot publish to it.
-- The CASE keeps a malformed topic from erroring on the uuid cast (it just denies).
create policy wallet_broadcast_receive on realtime.messages for select to authenticated
using (
  extension = 'broadcast'
  and case
    when realtime.topic() ~ '^wallet:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_wallet_member(substr(realtime.topic(), 8)::uuid)
    else false
  end
);
