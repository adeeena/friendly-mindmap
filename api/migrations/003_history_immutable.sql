-- Retained history snapshots are evidence of past content: rows may be inserted or pruned, never edited.
CREATE FUNCTION reject_board_history_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Board history snapshots are immutable' USING ERRCODE = 'integrity_constraint_violation';
END
$$;

CREATE TRIGGER board_history_immutable BEFORE UPDATE ON board_history
  FOR EACH ROW EXECUTE FUNCTION reject_board_history_update();
