import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import sys
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "terminal-pane"
LOADER = importlib.machinery.SourceFileLoader("terminal_pane", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
pane_cli = importlib.util.module_from_spec(SPEC)
saved_path = os.environ.get("PATH")
LOADER.exec_module(pane_cli)
if saved_path is None:
    os.environ.pop("PATH", None)
else:
    os.environ["PATH"] = saved_path


class TerminalPaneWaitTests(unittest.TestCase):
    def test_tern_wait_captures_scrollback_and_surface_text(self):
        args = mock.Mock(backend="tern", wait_output="Ctrl+C exit", wait_timeout=1)
        with mock.patch.object(pane_cli, "call", return_value="Ctrl+C exit") as call:
            pane_cli.wait_output(args, "BLOCK-7")

        command = call.call_args.args
        self.assertEqual(command[:5], ("tern", "capture", "BLOCK-7", "--surfaces", "--scrollback"))
        self.assertGreater(call.call_args.kwargs["timeout"], 0)

    def test_herdr_uses_native_wait_output_with_bounded_timeout(self):
        args = mock.Mock(backend="herdr", herdr_session=None, wait_output="Ctrl+C exit", wait_timeout=1.25)
        with mock.patch.dict(os.environ, {"HERDR_ENV": "1"}, clear=True):
            with mock.patch.object(pane_cli, "call", return_value="matched") as call:
                pane_cli.wait_output(args, "w1:p2")

        call.assert_called_once_with(
            "herdr", "pane", "wait-output", "w1:p2", "--match", "Ctrl+C exit",
            "--timeout", "1250", timeout=1.25,
        )

    def test_tmux_wait_times_out_without_a_match(self):
        args = mock.Mock(backend="tmux", wait_output="ready", wait_timeout=1)
        with mock.patch.object(pane_cli, "time") as clock:
            clock.monotonic.side_effect = [0, 0, 0.5, 1.1]
            with mock.patch.object(pane_cli, "call", return_value="still starting") as call:
                with self.assertRaisesRegex(RuntimeError, "timed out waiting for output"):
                    pane_cli.wait_output(args, "%17")

            clock.sleep.assert_called_once_with(0.1)
        self.assertEqual(call.call_args.args[:7], (
            "tmux", "capture-pane", "-p", "-t", "%17", "-S", "-",
        ))

    def test_herdr_command_arguments_remain_separate_shell_words(self):
        command = ["printf", "%s", "x; touch /tmp/unwanted", "$(touch /tmp/unwanted)", "'quoted'"]
        args = mock.Mock(herdr_session=None, mode="right", session=None, cwd="/tmp")
        response = {"result": {"pane": {"pane_id": "w1:p2"}}}
        with mock.patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1"}, clear=True):
            with mock.patch.object(pane_cli, "call", side_effect=[response, ""]) as call:
                self.assertEqual(pane_cli.herdr(args, command), "w1:p2")

        run_args = call.call_args_list[1].args
        self.assertEqual(run_args[:4], ("herdr", "pane", "run", "w1:p2"))
        self.assertEqual(shlex.split(run_args[4]), command)

    def test_capture_backend_failure_propagates(self):
        args = mock.Mock(backend="tern", wait_output="ready", wait_timeout=1)
        with mock.patch.object(pane_cli, "call", side_effect=RuntimeError("tern failed: pane unavailable")):
            with self.assertRaisesRegex(RuntimeError, "pane unavailable"):
                pane_cli.wait_output(args, "BLOCK-9")

    def test_main_preserves_json_when_wait_succeeds(self):
        command = ["printf", "%s", "hello; touch /tmp/unwanted"]
        stdout = io.StringIO()
        with mock.patch.object(sys, "argv", [
            str(SCRIPT), "--backend", "tern", "--session", "alerts", "--tab", "report",
            "--mode", "tab", "--wait-output", "ready", "--wait-timeout", "2", "--", *command,
        ]):
            with mock.patch.object(pane_cli, "tern", return_value="BLOCK-8") as launch:
                with mock.patch.object(pane_cli, "wait_output") as wait:
                    with contextlib.redirect_stdout(stdout):
                        pane_cli.main()

        self.assertEqual(launch.call_args.args[1], command)
        wait.assert_called_once_with(launch.call_args.args[0], "BLOCK-8")
        self.assertEqual(json.loads(stdout.getvalue()), {"backend": "tern", "pane": "BLOCK-8"})

    def test_main_auto_backend_prefers_tmux_context(self):
        stdout = io.StringIO()
        with mock.patch.object(sys, "argv", [str(SCRIPT), "--mode", "tab"]):
            with mock.patch.dict(os.environ, {
                "TMUX": "/tmp/tmux", "TMUX_PANE": "%1",
                "HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1", "TERN_PANE": "BLOCK-1",
            }, clear=True):
                with mock.patch.object(pane_cli, "tmux", return_value="%2") as launch:
                    with contextlib.redirect_stdout(stdout):
                        pane_cli.main()

        launch.assert_called_once()
        self.assertEqual(json.loads(stdout.getvalue()), {"backend": "tmux", "pane": "%2"})

    def test_main_does_not_print_success_json_when_wait_fails(self):
        stdout = io.StringIO()
        with mock.patch.object(sys, "argv", [
            str(SCRIPT), "--backend", "tmux", "--mode", "tab", "--wait-output", "ready",
        ]):
            with mock.patch.object(pane_cli, "tmux", return_value="%19"):
                with mock.patch.object(pane_cli, "wait_output", side_effect=RuntimeError("capture failed")):
                    with contextlib.redirect_stdout(stdout):
                        with self.assertRaisesRegex(RuntimeError, "capture failed"):
                            pane_cli.main()

        self.assertEqual(stdout.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
