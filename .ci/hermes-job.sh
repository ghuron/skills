#!/usr/bin/env bash
# A Hermes cron job on the CI box: runs a command as the skills-ci user, which holds the repo and the
# secrets, and prints its output for Hermes to deliver. Hermes runs as another user, so it gets in over
# ssh with a key that skills-ci's authorized_keys pins to one command. Each job has its own copy of
# this script in ~/.hermes/scripts/ and its own key, named after the copy:
#
#   skills-ci.sh       ~/.ssh/skills-ci_ed25519       command="bash /home/skills-ci/skills/.ci/run.sh"
#
# authorized_keys line: restrict,command="..." ssh-ed25519 AAAA... hermes cron -> <job>
# Install, as the Hermes user:
#   cp .ci/hermes-job.sh ~/.hermes/scripts/skills-ci.sh
#   hermes cron create '0 3 * * 1' --name skills-ci --script skills-ci.sh --no-agent --deliver whatsapp
exec ssh -i ~/.ssh/"$(basename "$0" .sh)"_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes skills-ci@localhost
