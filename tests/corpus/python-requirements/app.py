import streamlit as st
import pandas as pd

st.title("Q3 sales by region")
df = pd.DataFrame({"region": ["EMEA", "AMER", "APAC"], "revenue": [12, 19, 7]})
st.bar_chart(df.set_index("region"))
