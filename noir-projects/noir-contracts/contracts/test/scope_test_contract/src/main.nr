use dep::aztec::macros::aztec;

/// A simple contract for testing scope isolation on TXE.
/// Uses PrivateImmutable to store a single note per owner. Only owners should be
/// able to initialize their own notes, since their nsk are needed to do so
#[aztec]
pub contract ScopeTest {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::message_delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::{Owned, PrivateImmutable},
    };

    use field_note::FieldNote;

    #[storage]
    struct Storage<Context> {
        note: Owned<PrivateImmutable<FieldNote, Context>, Context>,
    }

    #[initializer]
    #[external("private")]
    fn constructor() {}

    /// Creates a note with the given value for the specified owner.
    /// The note is delivered to the owner so they can discover it.
    #[external("private")]
    fn create_note(owner: AztecAddress, value: Field) {
        let note = FieldNote { value };
        self.storage.note.at(owner).initialize(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    /// Reads the note owned by the specified owner and returns its value.
    #[external("private")]
    fn read_note(owner: AztecAddress) -> Field {
        let note = self.storage.note.at(owner).get_note();
        note.value
    }

    mod test {
        use crate::ScopeTest;
        use aztec::{
            protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment,
        };

        unconstrained fn setup() -> (TestEnvironment, AztecAddress) {
            let mut env = TestEnvironment::new();
            let deployer = env.create_light_account();

            // Deploy the contract
            let contract_address = env.deploy("ScopeTest").with_private_initializer(
                deployer,
                ScopeTest::interface().constructor(),
            );

            (env, contract_address)
        }

        /// Test that the owner can read their own notes
        #[test]
        unconstrained fn owner_can_read_own_notes() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let value: Field = 42;

            // Alice creates a note for herself (delivered encrypted to her)
            env.call_private(alice, ScopeTest::at(contract_address).create_note(alice, value));

            // Alice can read her own note
            let read_value =
                env.call_private(alice, ScopeTest::at(contract_address).read_note(alice));
            assert_eq(read_value, value);
        }

        /// Bob tries to create a note for Alice.
        /// This should FAIL because Bob cannot access Alice's keys.
        /// The PrivateImmutable.initialize() requires the owner's nullifier secret key,
        /// and scope isolation prevents Bob from accessing Alice's keys.
        #[test(should_fail_with = "Key validation request denied")]
        unconstrained fn bob_cannot_create_note_for_alice() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let bob = env.create_light_account();
            let value: Field = 42;

            // Bob tries to create a note for Alice - this FAILS due to scope isolation
            // Bob cannot access Alice's nullifier secret key
            env.call_private(bob, ScopeTest::at(contract_address).create_note(alice, value));
        }

        /// Alice creates a note for herself, then Bob tries to read it.
        /// Bob should NOT be able to read Alice's notes - scope isolation prevents this.
        ///
        /// This test expects failure with "Failed to get a note" because Bob cannot
        /// read notes scoped to Alice.
        #[test(should_fail_with = "Failed to get a note")]
        unconstrained fn bob_cannot_read_alice_notes() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let bob = env.create_light_account();
            let value: Field = 42;

            // Alice creates a note for herself
            env.call_private(alice, ScopeTest::at(contract_address).create_note(alice, value));

            // Bob tries to read Alice's note - this FAILS due to scope isolation
            let _read_value =
                env.call_private(bob, ScopeTest::at(contract_address).read_note(alice));
        }

    }
}
