//! PostgreSQL-only SQLx facade.
//!
//! The upstream `sqlx` facade resolves optional macro and database-driver packages into
//! `Cargo.lock` even when those features are disabled. Brocade only uses runtime-checked
//! PostgreSQL queries, so exposing the core and PostgreSQL crates directly keeps unused MySQL,
//! SQLite, proc-macro and RSA code out of the resolved supply chain without changing call sites.

pub use sqlx_core::acquire::Acquire;
pub use sqlx_core::arguments::{Arguments, IntoArguments};
pub use sqlx_core::column::{Column, ColumnIndex};
pub use sqlx_core::connection::{ConnectOptions, Connection};
pub use sqlx_core::database::{self, Database};
pub use sqlx_core::describe::Describe;
pub use sqlx_core::error::{self, Error, Result};
pub use sqlx_core::executor::{Execute, Executor};
pub use sqlx_core::from_row::FromRow;
pub use sqlx_core::migrate;
pub use sqlx_core::pool::{self, Pool};
pub use sqlx_core::query::{query, query_with};
pub use sqlx_core::query_as::{query_as, query_as_with};
pub use sqlx_core::query_builder::{self, QueryBuilder};
pub use sqlx_core::query_scalar::{query_scalar, query_scalar_with};
pub use sqlx_core::raw_sql::{raw_sql, RawSql};
pub use sqlx_core::row::Row;
pub use sqlx_core::statement::Statement;
pub use sqlx_core::transaction::{Transaction, TransactionManager};
pub use sqlx_core::type_info::TypeInfo;
pub use sqlx_core::types::Type;
pub use sqlx_core::value::{Value, ValueRef};
pub use sqlx_core::Either;
pub use sqlx_postgres::{
    self as postgres, PgConnection, PgExecutor, PgPool, PgTransaction, Postgres,
};

pub mod types {
    pub use sqlx_core::types::*;
}

pub mod encode {
    pub use sqlx_core::encode::{Encode, IsNull};
}

pub use encode::Encode;

pub mod decode {
    pub use sqlx_core::decode::Decode;
}

pub use decode::Decode;

pub mod query {
    pub use sqlx_core::query::{Map, Query};
    pub use sqlx_core::query_as::QueryAs;
    pub use sqlx_core::query_scalar::QueryScalar;
}

pub mod prelude {
    pub use super::{
        Acquire, ConnectOptions, Connection, Decode, Encode, Executor, FromRow, IntoArguments, Row,
        Statement, Type,
    };
}
